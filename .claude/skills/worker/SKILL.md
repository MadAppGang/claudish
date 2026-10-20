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
   - **Veille quota MiniMax** (mandat user 19/10) : organe **mono-observateur** — seul
     le siège hub (po-2025, celui dont le profil playwright persistant porte la session
     console) lit la console et appende `~/.claudish/minimax-plan-watch.log` ; les autres
     sièges ne relancent PAS playwright, ils lisent son journal ou sa ligne dashboard
     (une condition asynchrone = un observateur). Seuils WARN/ASK, formule de projection
     et leviers : `reference.md` §« Cycle » — l'énoncé canonique y vit seul, ne pas le
     reformuler ici (deux énoncés dérivent, mesuré : contradiction 36 h/24 h).
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

- **Lecture trafic** (instrument live, `-Container` sidecar, verdicts leak, grepper
  `cc_is_subagent`) : `CLAUDE.md` §« Traffic Analysis & Anthropic Policy » (doublon
  vérifié, chargé dans ce workspace).
- **`docker logs --since` sur po-203** : tronque la fin, `--tail` instable → **filtrage
  timestamp** (`docker logs -t | awk`) + croiser `/captures` ; 1 seule invocation
  `--since` par fenêtre.
- **Comptage watchdog** : « N bannières » = PAR JOUR — compter l'après-dernier
  horodatage de marche (tout le fichier = fausse alerte).
- **Panne machine** (gel, docker mort) : Event Log System AVANT le proxy (Id 26 commit
  charge, Kernel-Processor-Power). Leviers : pagefile, cap WSL2.
- **Déploiement** : règles d'appel (`Invoke-ClaudishDrainedRestart -Recreate -EnvFile`
  obligatoire, détaché + poll `OUTCOME` — grep **sans ancre**, préfixe `[ts]`, détail
  dans `ops-scripts.md` §drain `-Detach` — jamais inline, jamais de handle bloquant sur
  `drain.log`) : `CLAUDE.md` §« Never-Hang Constraints » + `reference.md` §« Pièges ».
  Spécificités absentes du CLAUDE.md : jumeau `<id>_<nom>` Created ⇒ `docker rm`
  avant retry ; bind-mount seul changé ⇒ `compose up -d` no-op silencieux → drain à
  zéro + `--force-recreate`, ou `docker restart` drainé si ni image ni `.env` ne
  changent (relit le bind, préserve l'env).
- **Clé z.ai, fenêtre 5 h épuisée** : un **1308** (quota, reset horodaté) prouve la clé
  ACCEPTÉE (401 = morte) ; même reset sur les deux lanes (`gc@`/`zai@`) ⇒ même compte.
- **Pénurie flotte** : latence headers du hub gonflée par la MARCHE DE CASCADE — un
  canary > 90 s ≠ hub en panne (`/health` 200) ; flap du relais = instrument de l'état
  des lanes du hub, pas un défaut local.
- **Failover** : `roleFromModelName()` et `CLAUDISH_FAILOVER_ROLE_MODELS` :
  `CLAUDE.md` §« Budget Failover ». **JAMAIS config-armer au mur** (tue
  l'auto-recovery) — absent du CLAUDE.md, garde ici.

## Protocole affermi (mandat user 2026-09-12 — non négociable)

Les 5 règles dures : `CLAUDE.md` §« Fleet-Rollout Verification » — quasi
verbatim, chargé dans ce workspace.

## Harness partagé

Le harness vit dans CE dépôt (`.claude/`, plus gitignoré en bloc — seuls `worktrees/`
et `scheduled_tasks.lock` restent machine-locaux). Tout ajout de règle/skill/agent
utile au cluster passe par un commit ici, jamais un fichier local non partagé.
