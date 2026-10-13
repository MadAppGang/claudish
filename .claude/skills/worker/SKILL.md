---
name: worker
description: Running règle le rôle de worker du cluster claudish — boucle de cycle (dashboard → inbox → exécution → commit+PR → rapport DONE), ré-armement cadence, et pièges du périmètre hub observé par un worker. Équivalent côté exécutant du skill de coordination d'ai-01.
---

# Worker — Cluster Claudish

Worker du cluster claudish : périmètre (hub, scripts traffic-*, watchdog), rapport
sur le dashboard workspace, cadence tenue. **Faire avancer les issues** : voir le
skill **`worker-issues`**.

> **Version complète** (mesures, incidents fondateurs, narratives) : `reference.md`,
> verbatim `71491e7a`, non chargé — chaque piège y a sa preuve mesurée.

## Cycle de travail — ordre OBLIGATOIRE

1. **Dashboard** : `roosync_dashboard(action: "read", type: "workspace", section: "all")`
   — messages récents, dispatches, ASK.
2. **Inbox** : `roosync_messages(action: "inbox")` — HIGH d'abord, marquer READ après
   lecture intégrale.
3. **Exécution** : ton périmètre. Règle HARD : lire le body complet + commentaires +
   diff avant tout comment/review/merge/fix.
   - **Relais journaux** (si les fichiers existent) : `~/.claudish/{model-version-events,session-watch}.log`
     (NDJSON) — relayer sur le dashboard les événements **plus récents que le
     watermark** (`~/.claudish/*-relay.ts`, une ligne ISO-UTC ; absent ⇒ tout relayer).
     **Mappings complets : `reference.md` §« Cycle »** —
     résumé : `major-ask`, `role-alias-ask`, `new-model`/`model-gone` touchant une
     cascade → **ASK** (un seul ask par (id, alias), le journal déduplique) ;
     `killed` (crossPost global), `kill-blocked-no-consent`, `rogue-schtasks`,
     `probe-fail`, `error`, `catalog-error` → WARN ; `exempt`, `skip-*`, `*-skip`,
     agrégats `*-majority`/`*-minority`/`no-binding-*` (sauf volume anormal) →
     silence ; le reste → INFO. Dures : watermark mis à jour après relais ; **JAMAIS tronquer les
     journaux** (trace durable des éditions d'infra) ; consent kill
     (`session-watch.kill.enabled`) : ≥24 h de journal sain avant armement, consigné.
4. **Commit + PR AVANT le rapport** — ne jamais annoncer un travail non commité.
   `git pull origin main` d'abord ; conventional commits. Body PR/commentaire :
   `--body-file <f>` — `--body @f` publie le chemin (6 corps vides au 13/10) ;
   relire le body publié avant de le citer.
5. **Rapport [DONE] sur le dashboard workspace** — faits, métriques, décisions.
   Tags : `DONE`, `ASK` si arbitrage user.
6. **Ré-armement** (si session interactive coord/worker) :
   `ScheduleWakeup(delaySeconds: 3540, …)`. Cadence portée par cron externe
   (tâche planifiée, `/hub-cron`) → NE PAS ré-armer.

## Pièges du périmètre hub — décisions (preuves : `reference.md` §« Pièges »)

- **Traces proxy live** → MCP `claudish_traffic` (#72), PAS `traffic-live.ps1` (verdicts
  faux sur corpus roté) ; le script garde la cadence 6 h, aucun nouvel appelant.
- **`traffic-live.ps1 -Container`** : défaut = `claudish-proxy` (hub) — sidecar ⇒
  `-Container claudish-sidecar`, sinon exit 1.
- **`docker logs --since` sur po-203** : tronque la fin, `--tail` instable → **filtrage
  timestamp** (`docker logs -t | awk`) + croiser `/captures` ; 1 seule invocation
  `--since` par fenêtre.
- **Comptage watchdog** : « N bannières » = PAR JOUR — compter l'après-dernier
  horodatage de marche (tout le fichier = fausse alerte).
- **Panne machine** (gel, docker mort) : Event Log System AVANT le proxy (Id 26 commit
  charge, Kernel-Processor-Power). Leviers : pagefile, cap WSL2.
- **Déploiement** : `Invoke-ClaudishDrainedRestart -Recreate -EnvFile <chemin>`
  (`-EnvFile` **obligatoire**), **détaché** + poll `drain.log` jusqu'à `OUTCOME` (grep
  SANS ancre — préfixe `[ts] `), **jamais inline** (pire cas 12,5 min). Jumeau
  `<id>_<nom>` Created ⇒ `docker rm` avant retry. Bind-mount seul changé ⇒ `compose up
  -d` no-op silencieux : drain à zéro + `--force-recreate`, ou `docker restart` drainé
  si ni image ni `.env` ne changent (relit le bind, préserve l'env).
  **JAMAIS de handle bloquant sur `drain.log`** (`tail -f` : verrouille l'écriture,
  7 h mesuré) : surveiller `docker inspect`/`/health`.
- **Clé z.ai, fenêtre 5 h épuisée** : un **1308** (quota, reset horodaté) prouve la clé
  ACCEPTÉE (401 = morte) ; même reset sur les deux lanes (`gc@`/`zai@`) ⇒ même compte.
- **Pénurie flotte** : latence headers du hub gonflée par la MARCHE DE CASCADE — un
  canary > 90 s ≠ hub en panne (`/health` 200) ; flap du relais = instrument de l'état
  des lanes du hub, pas un défaut local.
- **Failover** : `roleFromModelName()` ne matche que `opus|sonnet|haiku|fable` — un
  client nommant `glm-5.2` rate la cascade sans `CLAUDISH_FAILOVER_ROLE_MODELS`. Ne pas
  config-armer un failover correct ; **JAMAIS config-armer au mur** (tue l'auto-recovery).
- **Leak policy** : Opus/Fable/Sonnet = ai-01 uniquement. `traffic-anthropic.ps1` exige
  `pwsh` ; ne jamais grepper `cc_is_subagent` à la main.

## Protocole affermi (mandat user 2026-09-12 — non négociable)

1. **Issue à moitié traitée = issue en échec.** Pas de grain suivant tant que le DoD de
   l'issue en cours n'est pas atteint, ou re-scope explicite enregistré.
2. **Tout « FAIT » flotte exige un artefact de vérification MESURÉ, par consommateur,
   dans la même session** — lu sur le chemin vivant (web.config ARR,
   `ANTHROPIC_BASE_URL`, `docker inspect`), pas sur l'intention.
3. **Une panne détectée se escalade dans LE cycle qui la détecte** (DM URGENT +
   dashboard). Les seuils « chronique » ne s'appliquent jamais à une panne totale.
4. **Une vérification doit détecter les REVERTS silencieux** : re-lire l'artefact
   (ex. backend ARR de models.myia.io), pas la mémoire qu'il fut vérifié.
5. **Un revert de config partagée non loggé = incident** (GitHub issue + escalade),
   jamais une anomalie à absorber.

## Harness partagé

Le harness vit dans CE dépôt (`.claude/`, plus gitignoré en bloc — seuls `worktrees/`
et `scheduled_tasks.lock` restent machine-locaux). Tout ajout de règle/skill/agent
utile au cluster passe par un commit ici, jamais un fichier local non partagé.
