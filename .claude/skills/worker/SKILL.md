---
name: worker
description: Running règle le rôle de worker du cluster claudish — boucle de cycle (dashboard → inbox → exécution → commit+PR → rapport DONE), ré-armement cadence, et pièges du périmètre hub observé par un worker. Équivalent côté exécutant du skill de coordination d'ai-01.
---

# Worker — Cluster Claudish

Tu es un **worker** du cluster claudish : tu exécutes le travail sur ton périmètre
(observation du hub po-2023, scripts traffic-*, watchdog), tu rapportes sur le
dashboard workspace, et tu maintiens ta cadence. Le coordinateur (ai-01) dispatche
et centralise ; le hub (po-2023) observe ; les machines consomment.

## Cycle de travail — ordre OBLIGATOIRE

1. **Dashboard** : `roosync_dashboard(action: "read", type: "workspace", section: "all")`
   — lire les messages récents, identifier dispatches et ASK.
2. **Inbox** : `roosync_messages(action: "inbox")` — HIGH d'abord, marquer READ
   après lecture intégrale.
3. **Exécution** : ton périmètre (voir ci-dessous). Règle HARD globale : lire le body
   complet + commentaires + diff avant tout comment/review/merge/fix.
4. **Commit + PR AVANT le rapport** — ne jamais annoncer un travail non commité.
   `cd d:/Dev/claudish && git pull origin main` d'abord ; conventional commits.
5. **Rapport [DONE] sur le dashboard workspace** — faits, métriques, décisions prises
   ou demandées. Tags : `DONE`, `ASK` si arbitrage user requis.
6. **Ré-armement** (si session interactive coord/worker) :
   `ScheduleWakeup(delaySeconds: 3540, reason: "Re-arme ping-pong ...")`.
   Si cadence gérée par cron externe (tâche planifiée, `/hub-cron`) → NE PAS ré-armer.

## Pièges du périmètre hub (vérifiés, ne pas réapprendre)

- **`traffic-live.ps1 -Container`** : défaut = `claudish-proxy` (hub). Sur un sidecar,
  passer `-Container claudish-sidecar` ou le script exit 1.
- **`--since Nh`** : réévalué à chaque invocation → 1 seule invocation par fenêtre ;
  snapshoter une fois, ancrer sur `^ *\[resp\] `. `--tail` = fallback sur signature
  GOTCHA #2 seulement.
- **Comptage watchdog** : référence « 13 bannières » = PAR JOUR, pas cumulé. Scanner
  tout le fichier rend 111 et fabrique une fausse ALERTE. Ne compter que
  l'après-dernier-horodatage de marche.
- **Id 26 commit charge** : la panne 02/09 = épuisement commit charge hôte. Diagnostiquer
  via Event Log System AVANT le proxy. Leviers : pagefile, cap WSL2, migration po-2025.
- **`docker restart` ≠ reload .env/image** : hotfix config/image = `docker compose up -d`.
  Toujours `Invoke-ClaudishDrainedRestart -Recreate -EnvFile <chemin>` pour déployer :
  `-EnvFile` est **obligatoire** avec `-Recreate` et refuse vite sans lui — compose interpole
  chaque `${VAR:-}` depuis ce fichier, et le vrai `.env` du hub vit **hors** du répertoire
  compose (07/09 : un recreate nu a vidé tous les `CLAUDISH_FAILOVER_*`).
  ⚠ Et si seul un **fichier bind-mounté** a changé (ex. `config.json`), `compose up -d`
  est un **no-op silencieux** — compose ne voit aucun delta, le process garde l'ancienne
  config en mémoire. Preuve : `uptimeSec` non reset. Il faut drainer à zéro flux puis
  `docker compose up -d --force-recreate` (mesuré 15/09 bascule claudish-2 po-203 :
  1er passage no-op en 0s, 2e passage Recreated + uptime 12s).
- **Failover** : `roleFromModelName()` matche que `opus|sonnet|haiku|fable` → un client qui
  nomme `glm-5.2` rate la cascade sans `CLAUDISH_FAILOVER_ROLE_MODELS`. Ne pas config-armer
  un failover qui tourne déjà correctement (sonnet ARMED sur Mistral GLM 5.2 = attendu).
- **Leak policy** : Opus/Fable/Sonnet = ai-01 uniquement. `traffic-anthropic.ps1` exige
  `pwsh`. Ne jamais grepper `cc_is_subagent` à la main.

## Protocole affermi (mandat user 2026-09-12 — non négociable)

Le user a jugé notre protocole insuffisant après trois échecs réels : migration
déclarée FAITE sans vérification clients (flip ARR annulé le 07/09, personne ne
l'a vu), matrice #3574 laissée à 3/7 sans relance, panne hub non escaladée
pendant la panne. Règles effectives :

1. **Issue à moitié traitée = issue en échec.** Pas de grain suivant tant que
   le DoD de l'issue en cours n'est pas atteint, ou re-scope explicite enregistré.
2. **Tout « FAIT » sur un changement flotte exige un artefact de vérification
   MESURÉ, par consommateur, dans la même session** — où atterrit chaque client,
   lu sur le chemin vivant (web.config ARR, ANTHROPIC_BASE_URL par machine,
   docker inspect), pas sur l'intention du changement.
3. **Une panne détectée se escalade dans LE cycle qui la détecte** (DM URGENT +
   dashboard). Les seuils « chronique » ne s'appliquent jamais à une panne totale.
4. **Une vérification doit détecter les REVERTS silencieux** : un chemin
   critique vérifié hier peut avoir été annulé cette nuit — re-lire l'artefact
   (ex. backend ARR de models.myia.io), pas seulement la mémoire qu'il fut vérifié.
5. **Un revert de config partagée non loggé = incident** (GitHub issue +
   escalade), jamais une anomalie à absorber.

## Harness partagé

Le harness vit dans CE dépôt (`.claude/`, plus gitignoré en bloc — seuls
`worktrees/` et `scheduled_tasks.lock` restent machine-locaux). Tout ajout de
règle/skill/agent utile au cluster passe par un commit ici, jamais un fichier
local non partagé. Le skill de coordination d'ai-01 est attendu par ce même canal.