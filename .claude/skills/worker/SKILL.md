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
  Toujours `Invoke-ClaudishDrainedRestart -Recreate` pour déployer.
- **Failover** : `roleFromModelName()` matche que `opus|sonnet|haiku|fable` → un client qui
  nomme `glm-5.2` rate la cascade sans `CLAUDISH_FAILOVER_ROLE_MODELS`. Ne pas config-armer
  un failover qui tourne déjà correctement (sonnet ARMED sur Mistral GLM 5.2 = attendu).
- **Leak policy** : Opus/Fable/Sonnet = ai-01 uniquement. `traffic-anthropic.ps1` exige
  `pwsh`. Ne jamais grepper `cc_is_subagent` à la main.

## Harness partagé

Le harness vit dans CE dépôt (`.claude/`, plus gitignoré en bloc — seuls
`worktrees/` et `scheduled_tasks.lock` restent machine-locaux). Tout ajout de
règle/skill/agent utile au cluster passe par un commit ici, jamais un fichier
local non partagé. Le skill de coordination d'ai-01 est attendu par ce même canal.