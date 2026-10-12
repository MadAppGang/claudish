<!--
  reference.md — copie VERBATIM du runbook worker complet, tel que SKILL.md le portait
  au commit 71491e7a (12/10/2026), avant le découpage #445 (A4).
  NON chargé par défaut : le cœur opératoire est SKILL.md, qui pointe ici par section.
  Tout ce qui suit la ligne de séparation ci-dessous est octet pour octet le SKILL.md de 71491e7a
  (preuve : tail -n +12 reference.md | cmp - <(git show 71491e7a:.claude/skills/worker/SKILL.md)).
  Instantané daté : les valeurs vivantes (cadence, topologie, pièges) font foi dans SKILL.md.
  Pour justifier ou étendre une règle du cœur, lire la section homonyme ici.
-->

<!-- ===== verbatim SKILL.md @ 71491e7a ===== -->
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
   - **Relais model-version-watch** (si le fichier existe) : lire
     `~/.claudish/model-version-events.log` (NDJSON), relayer sur le dashboard
     workspace les événements **plus récents que le watermark**
     (`~/.claudish/model-version-relay.ts`, une ligne ISO-UTC : dernier `ts`
     relayé ; fichier absent ⇒ tout relayer) — `minor-applied` → tag INFO (le
     champ `detail` dit si le reload a été différé au restart quotidien ou
     déclenché immédiatement : ancien id retiré amont), `major-ask` → tag
     **ASK** (arbitrage user, la majeure seule n'arme rien),
     `role-alias-ask` → tag **ASK** (un nom demandable par un client — clé de
     routage — n'est couvert par aucun motif de `CLAUDISH_FAILOVER_ROLE_MODELS`
     ni mot-clé de rôle : un client nommant cet id résout **aucun rôle** et
     perd toute cascade — le champ `from` porte l'alias exact à ajouter,
     `to` l'id ; geste opérateur = env + recreate drainé, à grouper ; **un seul
     ask par (id, alias suggéré)**, le journal d'événements déduplique — ne pas
     re-signaler un identifiant déjà relayé),
     `probe-fail`/`error` → tag WARN, `info` → tag INFO (membre d'une famille sur
     un provider **non surveillé** — `oai@`, ou nu : non sondé, non touché, une
     ligne d'information, pas une action). Après relais, mettre à jour le watermark
     avec le dernier `ts` relayé. **Ne JAMAIS tronquer ni vider le fichier** :
     il est la seule trace durable des éditions automatiques de l'infra
     partagée (post-mortem après incident), et une troncature détruirait les
     événements arrivés pendant le relai.
   - **Relais session-watch** (organe bg 07/10, tâche planifiée `ClaudishSessionWatch`
     15 min, non élevée — remplace le cron tripwire interactif, mandat user) : lire
     `~/.claudish/session-watch.log` (NDJSON : `ts`, `kind`, `sid`, `detail`), relayer
     les événements plus récents que le watermark `~/.claudish/session-watch-relay.ts`
     (une ligne ISO-UTC ; absent ⇒ tout relayer). Mapping : `killed` → **WARN**
     (crossPost global) ; `kill-blocked-no-consent` → WARN locale (une cible qualifiée
     attend le consent kill) ; `new-model`/`model-gone` → INFO, ou **ASK** si l'id
     touche une cascade (ex. retrait de `MiniMax-M3` = ASK immédiat — lane la plus
     chargée du hub ; arrivée d'un `M3.1`/Flash = ASK banc comparatif) ;
     `remote-openai` → INFO (machine propriétaire nommée dans `detail` — pas un geste
     local) ; `sonnet-majority`/`sol-minority`/`no-binding-*` → silence sauf volume
     anormal (agrégat /worker) ; `exempt` → **jamais relayé** (comptage /worker
     seulement) ; `rogue-schtasks` → **WARN** (tâche planifiée dont l'action lance
     une session claude — classe split-brain, escalade po-2027 07/10 ; triage :
     nom journalisé seul, vérifier l'action réelle avant tout geste, propriétaire
     roo-extensions pour les launchers cachés) ; `skip-unattributed` → silence
     (benigne par construction depuis B1/CR 07/10 : une ligne sans session_id ne peut
     plus rien lier ni tuer — comptage /worker seulement) ; `scan-skip`/
     `catalog-skip` → silence (chemins hub absents sur une machine non-hub, N2/CR) ;
     `error`/`catalog-error` → WARN.
     Après relais, mettre à jour le
     watermark. **Ne JAMAIS tronquer le journal.** Consent kill = fichier
     `~/.claudish/session-watch.kill.enabled` — à n'armer qu'après ≥24 h de journal
     sain (classification conforme à la politique réconciliée), geste consigné
     dashboard.
4. **Commit + PR AVANT le rapport** — ne jamais annoncer un travail non commité.
   `cd d:/Dev/claudish && git pull origin main` d'abord ; conventional commits.
5. **Rapport [DONE] sur le dashboard workspace** — faits, métriques, décisions prises
   ou demandées. Tags : `DONE`, `ASK` si arbitrage user requis.
6. **Ré-armement** (si session interactive coord/worker) :
   `ScheduleWakeup(delaySeconds: 3540, reason: "Re-arme ping-pong ...")`.
   Si cadence gérée par cron externe (tâche planifiée, `/hub-cron`) → NE PAS ré-armer.

## Pièges du périmètre hub (vérifiés, ne pas réapprendre)

- **Traces proxy → outil MCP `claudish_traffic`** (livré, #72), pas `traffic-live.ps1`.
  Le MCP **refuse un verdict** quand `docker logs --since` a servi un corpus **roté**
  (le fichier courant du conteneur va plus loin que ce que `--since` a rendu) et rend
  l'histogramme **jusqu'à maintenant** — les buckets finaux vides SONT la réponse.
  A/B mesuré le 04/10 sur le relais .46, même fenêtre 24 h : le MCP a rendu `UNKNOWN`
  (corpus roté, fichier courant à 21:01Z vs `--since` arrêté à 19:18Z) là où
  `traffic-live.ps1` a rendu un verdict sur ce corpus non validé **et fabriqué 2 faux
  « HANG SUSPECTS »** à partir de lignes `[resp] capture write error: EIO` (un échec
  d'écriture de capture, pas un stream resté ouvert). Le script reste pour la cadence
  de surveillance 6 h ; ne pas lui ajouter de nouveaux appelants.
- **`traffic-live.ps1 -Container`** : défaut = `claudish-proxy` (hub). Sur un sidecar,
  passer `-Container claudish-sidecar` ou le script exit 1. (L'outil MCP prend
  `container` en argument.)
- **`--since Nh`** : réévalué à chaque invocation → 1 seule invocation par fenêtre ;
  snapshoter une fois, ancrer sur `^ *\[resp\] `. ⚠ Sur po-203 le `--since` **tronque la
  fin** (il s'arrête à l'arrêt précédent du conteneur et ignore le segment post-restart)
  et `--tail` est **instable** (`--tail 45` a rendu 0 ligne là où `--tail 25` rendait le
  segment) : mesurer par **filtrage timestamp** (`docker logs -t … | awk '$1 >= "…" && $1 <= "…"'`)
  et **croiser avec les captures** (`/captures`). `--tail` = fallback sur signature
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
  🔴 **Jamais en ligne dans un appel d'outil** : pire cas ≈12,5 min, au-delà du plafond d'un
  appel. Lancer **détaché** (`Start-Process` ou tâche planifiée), puis poller `drain.log` jusqu'à
  la ligne `OUTCOME` (#233/#236). Un appelant tué en plein compose a coupé le hub 16 min le
  23/09 ; et un jumeau `<ID[:12]>_<nom>` laissé derrière fait désormais **refuser** le run
  suivant avant tout arrêt : `docker rm` le jumeau nommé, puis relancer.
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
- **Ne JAMAIS suivre `drain.log` avec un handle de lecture bloquant** — `tail -f`,
  `Get-Content -Wait`, ou toute boucle qui garde le fichier ouvert : sous Windows ce handle
  **refuse les écritures**, et `Write-DrainLog` (`Add-Content` sans `-ErrorAction`) échoue
  **ligne par ligne, non-terminant, sans tuer le run**. Mesuré hub po-2025, 05/10 : un
  `tail -n 0 -f drain.log | grep` lancé pour suivre un recreate **n'est jamais sorti** et a
  tenu le fichier **7 h 10** ; deux recreates réels et réussis (dont un déploiement de hub)
  n'ont laissé **aucune trace** — `drain.log` figé à sa première ligne — et le moniteur
  attendait un `OUTCOME` que **son propre verrou** empêchait d'écrire (auto-blocage, aucune
  sortie possible). Surveiller `docker inspect`/`/health`, jamais le log du drain ; et
  **vérifier qu'un moniteur est bien sorti** (`Get-Process tail`) — « j'ai arrêté le
  moniteur » s'est révélé faux, il a survécu 7 h. Cf. #338 : le retry borné ferme la
  fenêtre transitoire, pas un détenteur **continu**.

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