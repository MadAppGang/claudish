---
name: worker
description: Running règle le rôle de worker du cluster claudish — boucle de cycle (dashboard → inbox → exécution → commit+PR → rapport DONE), ré-armement cadence, et pièges du périmètre hub observé par un worker. Équivalent côté exécutant du skill de coordination d'ai-01.
---

# Worker — Cluster Claudish

Tu es un **worker** du cluster claudish : tu exécutes le travail sur ton périmètre
(observation du hub po-2023, scripts traffic-*, watchdog), tu rapportes sur le
dashboard workspace, et tu maintiens ta cadence. Le coordinateur (ai-01) dispatche
et centralise ; le hub (po-2023) observe ; les machines consomment.

**Faire avancer les issues** (dispatch du coordinateur, sélection, PR avec `Closes #NN`) :
voir le skill **`worker-issues`** — cycle complémentaire à celui-ci, même machine.

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
  ✅ **Alternative mesurée (po-2025, même bascule, 15/09 08:07Z)** : un **`docker restart` drainé
  suffit** quand ni l'image ni le `.env` ne changent — le process redémarre et **relit le
  fichier bind-monté**, tout en **préservant l'env du container** (donc zéro risque de vider les
  `CLAUDISH_FAILOVER_*`). Effet secondaire mesuré : restart = **pas de zéro garanti**, 5 flux en
  vol coupés. Le no-op ne concerne QUE `compose up -d` (qui décide ou non de recréer). Si le
  « conteneur » est en fait un process bun lancé par script (sidecar hors compose) : kill +
  relance = recreate effectif, preuve = **PID neuf** (mesuré po-2024 : 170412 → 242088).
- **Acceptation d'une clé z.ai quand la fenêtre 5 h est épuisée** (aucun 200 atteignable) :
  un **1308** (quota, avec horodatage de reset) prouve que la clé est **acceptée** — une clé
  bidon renvoie **401 « token expired or incorrect »**. Comparer les **deux lanes** (`gc@`
  OpenAI-shaped `/api/coding/paas/v4/chat/completions` et `zai@` anthropic
  `/api/anthropic/v1/messages`) : **même instant de reset ⇒ même compte/bucket** (une clé neuve
  du même compte = rotation, pas un 2ᵉ quota). Plus rapide que d'attendre le reset (po-2025, 15/09).
- **Sous pénurie de quota flotte, la latence headers du hub est gonflée par la MARCHE DE CASCADE** —
  chaque marche murée est essayée avant que les headers ne partent. Mesuré po-203, 3 h de pénurie
  totale (15/09 ~07:30-10:30Z) : **1 390 forwards `[ttft]`, 44 replis `header-timeout` servis localement,
  2 épisodes AUTONOMOUS** (déclenchés par `hub HTTP 500`, pas par le budget 30 s). Un canary
  d'acceptation peut alors **dépasser 90 s** sans que le hub soit en panne (`/health` 200, streams
  actifs) : c'est la cascade qui marche. Le flap du relais est ici un **instrument de l'état des
  lanes du hub**, pas un défaut local.
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