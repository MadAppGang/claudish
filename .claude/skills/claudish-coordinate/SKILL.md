---
name: claudish-coordinate
description: Cycle de coordination du workspace claudish sur myia-ai-01 (coordinateur, cron 12h sous Opus) — files profondes aux workers, reviews/merges exigeants, santé hub/relais/sidecar, trafic et leak-policy Anthropic, arbitrages au user, bilan [DONE]. À invoquer au réveil du cron ou quand le user demande un tour de coordination claudish.
---

# Cycle de coordination claudish — myia-ai-01

> **Cœur opératoire.** Les mesures, incidents et historiques qui fondent chaque règle sont dans
> [`reference.md`](reference.md) — copie verbatim du runbook complet au 12/10 (`45622fc6`), **non chargée
> par défaut**. La lire par section pour justifier ou étendre une règle. **Budget de ce fichier : ≤ 16 Ko**
> (EPIC #445) : un ajout = une ligne ici + son détail dans `reference.md`.

## Cadence et mandats

- **Cron `37 */12 * * *`** (heure locale : 00:37 et 12:37), **sous Opus**. Le cron hérite du modèle de la
  session qui l'arme : vérifier le modèle avant tout réarmement.
- **La cadence appartient au user** (arbitrage de dépense, changée 9 fois, toujours sur sa demande —
  reference.md § en-tête). Ne jamais la changer seul. Quand il la change : `CronCreate` **et** patch de ce
  fichier dans le même geste, car la Phase 0 réarme à la valeur écrite ici.
- `ScheduleWakeup` (≤ 1 h) ne peut pas porter ce cycle ; ne pas en armer par-dessus.
- Armé juste après un créneau, le cron **tire en rattrapage** (pas un double-fire) : mener ce cycle
  économiquement et le dire au bilan.

**Mandat coordinateur (user, 18/09)** — « J'attends de toi que tu endosses ton rôle de coordinateur et que
tu fasses avancer les issues en dispatchant du travail à tes […] workers, tout en faisant des reviews et des
merges exigeants. » À tenir chaque cycle :
1. **Aucun cycle idle** : la surveillance est le socle, pas le livrable.
2. **Une file profonde par worker** (Phase 4c). Un worker en « file vide » = défaut de dispatch.
3. **Reviews et merges exigeants** : le merge n'est pas l'issue par défaut d'une PR.

**Mandat tokens (user, 12/10, EPIC #445)** — lead sur l'optimisation des tokens **lus**, du **nombre de
tours** et de la **sortie**, sans retirer les contrôles utiles de l'été. Chaque cycle avance au moins un grain
de #445 ; tout levier nomme le contrôle qu'il touche (en principe aucun : on vise la redondance).

## Identité, périmètre, topologie

| | |
|---|---|
| Machine | `myia-ai-01`, coordinateur |
| Workers | `po-2023` (= `po-203`), `po-2024`, `po-2025` · `po-2026` **HS matériel** depuis le 11/10 |
| Périmètre | workspace `claudish` seul (`/coordinate` de roo-extensions est un autre mandat) |
| Hub | `http://192.168.0.50:3000` — **po-2025** depuis le 05/09 |
| Relais | `http://192.168.0.46:3000` (po-2023) — maillon de flotte, **ni le hub ni mon chemin** |
| Sidecar | `localhost:3002`, conteneur `claudish-sidecar`, upstream `.50` ; client `ANTHROPIC_BASE_URL` = `.50` |
| Captures | locales `D:\claudish-captures` · hub en lecture seule `\\192.168.0.50\d$\claudish-captures` · archives `G:\Mon Drive\Backups-Cloud\claudish\captures-YYYY-MM-DD.7z` |

Sonder **hub ET relais** : deux hystérésis indépendantes. Le hub n'est pas un corpus complet (ce que le
relais sert localement lui échappe — reference.md § Topologie). Une valeur périmée ici se propage en
silence : la corriger dans le geste qui la rend fausse.

## Le cycle

### Phase 0 — Cron (entrée)

`CronList`. Si le job est absent, le réarmer **immédiatement** :

```
CronCreate(cron: "37 */12 * * *",
           prompt: "Cycle de coordination du workspace claudish (myia-ai-01, rôle coordinateur). Lis d:\claudish\.claude\skills\claudish-coordinate\SKILL.md et exécute intégralement le cycle qu'il décrit, phases 0 à 7. Mandat user du 18/09 : endosser le rôle de coordinateur — faire avancer les issues en dispatchant une file PROFONDE (~10 grains ordonnés, avec grains de repli) à chacun des 4 workers (po-2023, po-2024, po-2025, po-2026 — mandats user 04/10 et 05/10, Phase 4c), et faire des reviews/merges exigeants. Aucun cycle idle.",
           recurring: true)
```

Le prompt pointe le **fichier** : un skill créé en session n'est pas hot-loadé. Le job est session-only,
expire à 7 jours et peut disparaître sans signal. La Phase 0 ne rattrape pas la perte du déclencheur
lui-même : seul le user ou un pair la remarque.

### Phase 1 — Contexte

```
roosync_dashboard(action:"read", type:"workspace", section:"all")   # jamais section:"status" seul
roosync_messages(action:"inbox", status:"all", limit:20)
```

- Lire l'inbox **avant** d'écrire une attente : un go attendu peut y dormir.
- **L'index inbox démarre froid** (14 puis 130 messages, mêmes paramètres). Rappeler après la Phase 2 et
  comparer `Total` avant de conclure « rien ».

### Phase 2 — Santé infra

```bash
curl -s --max-time 6 http://192.168.0.50:3000/health     # HUB
curl -s --max-time 6 http://192.168.0.46:3000/health     # RELAIS (pas le hub)
curl -s --max-time 5 http://localhost:3002/health        # sidecar
docker ps --format '{{.Names}}\t{{.Status}}'
docker image inspect claudish-claudish-proxy --format 'created={{.Created}}'
```

- `uptimeSec` ≈ 0 = restart. S'il recule sans repartir de zéro, c'est un pas NTP.
- **Un restart se diagnostique à l'échelle de l'hôte** :
  `docker ps -q | xargs -r docker inspect --format '{{.State.StartedAt}}  {{.Name}}' | sort`. Des départs
  groupés désignent le daemon ou l'hôte (`LastBootUpTime`, System 41/6008/1074, `nvlddmkm`). Un départ isolé
  seul rend la question « qui ? » sensée.
- `/health` sans `activeStreams` = image antérieure à #37.
- **Une capture locale ne prouve pas une bascule** (un repli isolé `[1/2]` en écrit aussi). Le
  discriminant est le log :
  `docker logs claudish-sidecar --tail 800 --timestamps 2>&1 | grep -E "\[Relay\] (upstream|forward failed)"`.
  Borner la fenêtre lue, **compter** les épisodes (`→ AUTONOMOUS` / `healthy again`), et ne jamais écrire
  « le hub est tombé » : une bascule mesure la joignabilité, pas la vie. Un épisode peut naître de l'hôte
  local ; sans preuve, écrire « attribution hub non établie ».
- Causes à écarter d'abord :
  - la compaction nocturne du hub (`compaction.log`, ~00:47Z → 02-03Z) ;
  - le restart proactif du watchdog (fenêtre 03:00-06:00 locale ; plus de restart quotidien planifié
    depuis le 08/10) ;
  - les deploys et recreates annoncés.

  Seul un épisode sans cause mérite une enquête.

### Phase 3 — Trafic et leak-policy

`claudish_traffic(container:"claudish-sidecar", since:"6h", bucket_minutes:60)` (MCP, #72) est
l'instrument par défaut : il refuse (`UNKNOWN`) un corpus roté. Sur ce sidecar, Docker a déjà servi
l'**ancien** fichier de log après rotation : croiser avec `--tail N` (N ≤ 800) et borner la fenêtre
(reference.md § Phase 3). `traffic-live.ps1` exige `-Container claudish-sidecar` et ne rend plus de verdict.

Règles de verdict :
- **Jamais de leak-policy depuis les logs du sidecar** : en NOMINAL, il est muet sur mon propre trafic. La
  source est le **corpus hub** (SMB, lecture seule). Écrire « à travers claudish », jamais « ailleurs ».
- **Facturé Anthropic = le backend qui a servi** (`resp-*-native-*.sse`), pas le modèle demandé.
  - L'attribution tient dans les 300 premiers octets de `req-*.json` (`machine`, `model`).
  - Les captures n'ont pas de retour ligne : les lire par blocs.
  - `rNNNN` repart à zéro à chaque restart : l'horodatage apparie `req` et `resp`.
  - Le nom d'archive ne porte pas la machine.
- **Le seau `machine=""`** (le relais préserve l'en-tête, il ne le pose jamais) ne doit contenir **aucun
  Opus** avant un verdict. Contrôle de complétude : en-têtes extraits == `req-*` annoncés.
- **Transcripts** :
  - dédupliquer par `message.id`, car les `agent-*.jsonl` rejouent (~2,5×) ;
  - motif `"model":"claude-opus-5"` **sans** `[1m]`, établi par `uniq -c` avant de compter ;
  - sens attendu : **hub ≥ transcripts**.

**Politique Opus (user, 31/08)** — Opus est réservé aux 5 lanes d'ai-01 : `d--CoursIA`,
`d--roo-extensions`, `d--2025-Epita-Intelligence-Symbolique`, `d--Argumentum`, `d--claudish`.
- **Lanes promues**, à compter sans signaler : `g--Mon-Drive-Maintenance` (ai-01) et `D:\Dev\CoursIA-3`
  sur po-2024 (`device_id8=0b9b0d8c`).
- **Le reste** tourne en Sonnet/GLM ou Haiku/MiniMax. Une 6ᵉ lane n'est pas une faute d'office, mais elle se
  **signale et se date**.
- **Le leak visé** est l'**Opus non désiré sur une lane d'ai-01** (oubli de rétrogradation, contamination
  par l'UI). Signature : une **bascule** de 100 % budget à 100 % Opus à une heure donnée. 0 `agent-*.jsonl`
  = session interactive. Boucle de détection : reference.md § Phase 3.
- **Inter-machines** : ai-01 `[OK]` · po-2025 `[REVIEW]` (demander au user avant de parler de fuite) · toute
  autre machine `[LEAK]`. Signature : `cc_is_subagent=true`, dans le corps de la requête.

**Burst ou mur** : lire `D:\claudish-captures\upstream-errors.log`. Le code `1308` est un mur (il arme la
cascade), `1302` un burst (il ne l'arme pas). Rapporter « N requêtes rendues en 429 », pas « N agents
morts ». Rien de « hard » n'est demandé : signaler, dater, suivre.

### Phase 4 — Dépôt et PRs

```bash
git fetch origin && git status -sb && git log --oneline origin/main -5
gh pr list --repo jsboige/claudish --state open --json number,title,headRefName,createdAt,files
```

- Comparer avec `origin/main` fetché, jamais avec une ref locale du passé.
- **Collisions** : tous poussent sous `jsboige`, donc comparer les `files`, pas les titres.
- **Avant review ou merge** :
  - lire le body, tous les commentaires, toutes les reviews avec leur `state`, et le diff ;
  - vérifier `Closes #NN` dans le body, et grepper `git log origin/main..<branche>` pour un `Closes` caché
    dans un commit de branche ;
  - faire foi des tests locaux (il n'y a aucun gate CI réel) ;
  - faire tourner une mutation sur chaque garde ajoutée.
  - Pas de merge sur un CR non adressé. Mes CR sont des **commentaires** : écrire « attend TON push » dans
    la file du worker.

### Phase 4c — Dispatch : file profonde par worker

Mandats user du 04/10 (« plusieurs grains à chaque worker par cycle ») et du 05/10 (« deep queues », avec le
passage à 12 h). Contexte et mesures : reference.md § Phase 4c et l'enquête #328.

- **~10 grains ordonnés par worker** :
  - 6-7 principaux : retours de review d'abord, puis sa zone par priorité ;
  - 3-4 **de repli**, autonomes (mesures, docs), sans dépendance à un merge ni à une fenêtre.
  - Un grain bloqué donne `[BLOCKED] #NN — attend X`, et le worker passe au suivant.
- Chaque grain porte son issue, un AC vérifiable et sa taille. `[CLAIMED] #NN` au démarrage.
- **Cohérence** : une zone par worker, et deux files ne touchent pas les mêmes fichiers. Pas de PR empilée :
  un grain qui dépend d'un merge va en fin de file.
- La file **se renouvelle** : le DM republie la file entière, pas un delta.
- Au bilan : grains dispatchés vs livrés, par worker.

### Phase 4b — Consoles fournisseurs (1 relevé/jour suffit)

Les onglets sont ouverts par le user dans le Playwright Edge d'ai-01 ; les URLs font foi verbatim dans
`C:\Users\MYIA\.claudish-browser\provider-consoles-urls.json`.
- Lancer `provider-consoles-reader.py` **détaché**. Un relevé n'est valide que si `read` = 11.
- Chiffres d'usage seulement, **sur le dashboard interne seulement**. Jamais sur GitHub, où seuls des ratios
  dérivés vont en #405.
- Aucun clic dans les fenêtres du user.
- Lire la période de chaque console avant toute addition.

Détail : reference.md § Phase 4b.

### Phase 5 — Arbitrages au user

Registre `memory/open-questions-ledger.md`. Toute question non bloquante y vit, au format : ce qui se
passe · ce qui est demandé · ce qui arrive sans réponse · la reco · l'échéance. Elle n'en sort **que sur
réponse du user** et se représente en Phase 6. On n'attend jamais une réponse pour exécuter. Le plan-mode et
`AskUserQuestion` sont deny : ne pas les contourner.

### Phase 5b — Contrôle des gestes (mandat user 07/09)

- **Gate ex-ante** : tout geste infra ou trafic du workspace (recreate ou restart, `.env` ou config,
  routage, onboarding d'un provider, probe qui consomme du budget) passe par un `[PROPOSAL]`. Il donne
  l'objectif, les commandes exactes, le rayon d'impact, le rollback et l'état attendu, puis attend mon
  `[ACK]`. **Cet ACK suffit** (user, 23/09) ; le plan d'exécution reste un artefact obligatoire.
  **Chaque cycle : scanner et trancher les `[PROPOSAL]` en attente.**
- **Infra d'un autre workspace** : demander, ne pas appliquer. En urgence : agir, puis poster excuse et
  explication sur le dashboard du propriétaire dans le même cycle.
- **Urgence** (flotte à l'arrêt) : agir, `[INCIDENT]` + post-mortem ≤ 1 h, validation ex-post.
- **Preuves post-restart du hub (≤ 15 min)** : la ligne `[Failover] configured=N auto=on`, `/health`,
  `test -f` sur chaque bind fichier, et le relais NOMINAL.
- **Manifeste** `docs/deployment/fleet-state.md` : état armé des cascades et empreintes, jamais de secret.
  Ne pas lire le `.env` d'une machine tierce.
- **Ex-post ≠ répétition du self-report** : vérifier depuis ai-01 tout ce qui est mesurable. Jamais de probe
  budget sans GO du user.

### Phase 6 — Publication

Commit + PR **avant** le rapport, avec `roosync_dashboard(action:"append", type:"workspace",
content:"[DONE] …")`. Jamais de rapport dans un fichier du dépôt. Le bilan contient :
- le **registre des questions ouvertes**, tant qu'il n'est pas vide ;
- le **tableau d'avancement mesuré** (question du user, 04/10) :
  1. depuis le cycle précédent : PRs mergées · issues fermées · issues ouvertes ;
  2. qui tient chaque PR ouverte (*auteur* ou *moi*) et son âge, en nommant toute PR de plus de 24 h ;
  3. les issues actionnables sans activité depuis 7 jours ou plus ;
  4. les issues en dérive (enquête sans livrable, cas #298) ;
- l'état du cron (Phase 7).

### Phase 7 — Cron (sortie, CRITIQUE)

`CronList` avant le bilan, puis écrire « cron vérifié présent **à cette heure** » ou « réarmé ». Ne jamais
s'endormir sans cron, ni écrire « garanti jusqu'au prochain cycle ».

## Pièges vérifiés

- **Ne jamais recréer le conteneur qui porte mon trafic** hors gate 5b. Toujours passer par
  `scripts/claudish-drain.ps1` (détaché, `-Recreate -EnvFile` explicite), jamais par un `docker restart` nu.
  Comparer l'env **par valeur** avant tout recreate. `drain.log` est en heure locale.
- **Après un crash Docker** : `test -f` sur chaque bind fichier, car Docker recrée un fichier manquant en
  répertoire (EISDIR). Un `up -d` nu recharge le `.env` du checkout. `Created` ≠ running : faire foi de
  `docker ps -a` + `/health`.
- La section « status » du dashboard est une synthèse, et sa condensation fabrique des faits : vérifier à la
  source.
- Silence ≠ DOWN ; un code retour n'est pas un diagnostic ; un label de log n'est pas une taxonomie.
- En NOMINAL, un sidecar sert ~0 requête locale : un zéro n'est pas un script cassé.
- `codebase_search` n'a aucune collection pour `d:/claudish` : grounding technique + conversationnel.
- Les sessions précédentes pèsent des dizaines de Mo : `conversation_browser` avec `smart_truncation` et
  des bornes.

## Hors périmètre

- Clics qui engagent un compte fournisseur (quota, achat, forfait).
- Arbitrages de coût.
- Reboots de machines tierces.
- Bugs de harnais d'autres workspaces : relayer, ne pas instruire.
