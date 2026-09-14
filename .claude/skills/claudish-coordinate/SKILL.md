---
name: claudish-coordinate
description: Cycle de coordination du workspace claudish sur myia-ai-01 (rôle coordinateur, cadence 6h). Lit dashboard + inbox, sonde le hub et le sidecar, contrôle le trafic et la leak-policy Anthropic, fait le point PRs, présente les arbitrages au user, publie un bilan [DONE]. À invoquer au réveil du cron ou quand le user demande un tour de coordination claudish.
---

# Cycle de coordination claudish — myia-ai-01

**Cadence :** **3h** via `CronCreate` (`37 */3 * * *`, heure locale) — **temporaire**, le temps de
l'audit de consommation (voir ci-dessous).

⚠️ **Cette valeur suit le budget Anthropic et a changé cinq fois** : 12h → 24h le 01/09
(famine annoncée pour le jeudi, reset vendredi 03h), puis 24h → **5h** le soir même (reset Anthropic
couvrant ~2 jours), puis 5h → **12h** le 03/09, puis 12h → **6h** le 06/09, puis 6h → **3h** le
14/09 — toutes sur demande du user. **Ne jamais la changer de sa propre initiative** — elle est un
arbitrage de dépense qui appartient au user. Revenir à 6h reste la décision du user une fois
l'audit clos.

🔎 **Piège de lecture du delta en Phase 0** : avec `*/N`, les créneaux sont des heures fixes, pas un
intervalle depuis le dernier tour. `*/5` donnait 0,5,10,15,20 — donc un saut de **4h** entre 20:37 et
00:37, qui ressemble à un double-fire sans en être un. `*/6` (0, 6, 12, 18) et `*/3` (0, 3, 6, …, 21)
n'ont pas ce défaut : 24 étant divisible par 6 et par 3, tous les écarts valent la cadence. Mesuré le
03/09, revérifié le 06/09.

🔴 **La Phase 0 ré-arme à la valeur écrite ICI.** Une cadence périmée dans ce fichier se réinstalle
donc toute seule au premier cron perdu, en silence. Patcher ce paragraphe **dans le même geste** que
le `CronCreate`, jamais après.

📌 **Tranché le 06/09 (~16:40 locale)** : demande user directe « réarmer un cron de coordination
6h », formulée alors que la Phase 0 venait de constater le cron **absent** — le job `ea077f32` du
cycle 25 n'avait pas survécu. Cron `51a80d37` armé à `37 */6 * * *` et ce paragraphe patché dans le
même geste. Historique : 03/09 (~01:30) réponse user « ralentir » → 12h immédiat, sans attendre la
fermeture de la fenêtre d'abondance (04/09 03:00). Même règle à chaque fois : ne pas décider seul,
mais ne pas laisser une cadence courir à côté du budget par simple oubli.

📌 **Tranché le 14/09 (~14:15 locale)** : demande user directe « passe ton cron à 3h le temps d'aller
au bout de cette histoire » — contexte : audit de consommation (une session CoursIA = 93 % de la
facture Anthropic, rampe de verbosité ×3-4 démarrée le 12/09 ~18:00Z). Cron `9a0570fa` armé à
`37 */3 * * *`, ce paragraphe et la ligne de cadence patchés dans le même geste. Le user a
parallèlement relevé de 20k le seuil de condensation de CoursIA (« ça empirera les coûts mais libère
la pression sur les condensations ») et averti CoursIA, qui collabore à l'audit — **effet de bord
précieux : c'est une expérience naturelle sur le taux de compaction, à surveiller dans l'audit**.

`ScheduleWakeup` est clampé à 1h max : il ne peut **pas** porter ce cycle. Ne pas en armer un par-dessus.
⚠️ **Armer le cron juste APRÈS un créneau déclenche un tir de rattrapage immédiat.** Mesuré le
06/09 : cron armé à 18:40 locale, soit 3 min après le créneau 18:37 — il a tiré à **19:07**, hors
grille (00:37/06:37/12:37/18:37), au premier moment d'inactivité après la clôture du cycle précédent.
Le cycle suivant démarre donc avec **~25 min de delta**, pas 6 h. Ce n'est pas un double-fire : c'est
le créneau manqué servi en retard. Conséquence opératoire : **mener ce cycle-là économiquement** —
sonder l'infra, traiter ce que le tour précédent a laissé (typiquement les messages non lus), et ne
pas refaire les analyses lourdes sur une fenêtre qui n'a pas bougé. Le dire dans le bilan.


---

## Identité et périmètre

| | |
|---|---|
| **Machine** | `myia-ai-01` — rôle **coordinateur** (décision 14/08) |
| **Pair** | `myia-po-2023` — rôle **exécutant**. `po-203` et `po-2023` sont **la même boîte** ; `po-2023` est le nom canonique (acté 27/08). ⚠️ **Il ne tient plus le hub depuis la bascule du 05/09** — voir Topologie |
| **Périmètre** | workspace `claudish` **uniquement**. Ignorer les dispatchs des autres workspaces (CoursIA, roo-extensions) |
| **Ne pas confondre** | `/coordinate` (roo-extensions, flotte RooSync, Project #67) est un **autre** mandat |

## Topologie (vérifiée 2026-09-06 — **bascule du 05/09, l'ancienne valait jusqu'au 05/09 12:06Z**)

🔴 **`192.168.0.46:3000` n'est plus le hub.** Depuis le cutover du 05/09 c'est un **relais**, et le
hub canonique est **po-2025**. Ce fichier a porté « Hub : .46 (po-2023) » pendant tout le cycle 24 :
un cycle qui sonde `.46` en croyant sonder le hub lit la santé du mauvais maillon et attribue les
pannes à la mauvaise machine. Même piège que la cadence — **une valeur périmée ici se propage en silence.**

- **Hub canonique** : `http://192.168.0.50:3000` (**po-2025**), depuis le 05/09 12:24:15Z.
- **Relais** : `http://192.168.0.46:3000` (po-2023) → po-2025 via forwarder TCP hôte `:18182`. ⚠️ **Ce n'est plus mon ancrage depuis le 07/09** — le double-hop est supprimé des deux côtés : `ANTHROPIC_BASE_URL` du client = `http://192.168.0.50:3000` (`settings.json`, écrit par le user à 21:26:02Z, GO flotte « Go pour tout le monde ») **et** `CLAUDISH_RELAY_UPSTREAM` du sidecar = `.50` (recreate 23:12:14Z). Le `.46` reste sondé comme **maillon de flotte** (c'est l'ancrage de po-2023/2026/2027) et comme cible de rollback, pas comme chemin de mon trafic. Gain mesuré : **17 replis `header-timeout` en 6 h avant → 0 après**.
- **Sidecar local** : `localhost:3002`, container **`claudish-sidecar`**, image `claudish-claudish-proxy`.
- **Captures locales** : `D:\claudish-captures` → `/captures` dans le container.
- **Code** : `d:\claudish` (fork `jsboige/claudish`).

⚠️ **Sonder les DEUX maillons, jamais un seul** : un `/health` vert sur `.46` ne dit rien de po-2025,
et l'inverse non plus. Il y a **deux couches d'hystérésis indépendantes** (mon sidecar → relais, relais → hub).

🔴 **Le hub n'est pas un corpus complet — le trou est RÉEL, mais il vaut 32, pas 169** (cycle 25,
2026-09-06). Tout ce que le relais sert **localement** (AUTONOMOUS *et* repli par requête sur
header-timeout) ne parvient jamais aux captures du hub. po-2023 l'a chiffré sur la fenêtre
12:25→19:28Z du 05/09 : **32 Opus servies localement pour `machine=myia-ai-01`** (première 15:28:31Z,
dernière 19:23:20Z), plus **0 requête Opus locale non-ai-01** — un contrôle négatif de politique qui
vaut d'être noté. Un verdict de leak-policy rendu depuis le hub seul est **valide sur le corpus hub**
et muet sur ces fenêtres. po-2025 a adopté la formulation « sur corpus hub » et ne revendique plus la
couverture totale ; le verdict flotte complet = captures hub **+** attribution locale du relais.

⚠️ **Correction du cycle 24, à lire comme un piège de méthode.** J'ai publié ici un résidu de
**+169** (1329 transcripts contre 1160 hub) avec le signe inversé, et je l'ai attribué au trou du
relais. **Les deux moitiés étaient fausses.** Sur ma fenêtre exacte, po-2025 recompte **1336 demandes
Opus/Fable, 100 % `machine=myia-ai-01`**, contre mes 1329 : `hub ≥ transcripts` **tient**, l'écart
vaut **+7** (retries et échecs, exactement ce que la règle prédit). Le +169 était un artefact de
**leur** fenêtre — leur comptage publié s'exécutait à ~17:57Z et coupait 90 min avant ma borne.
Trois leçons, dans l'ordre où elles mordent :

1. **Comparer deux nombres exige de vérifier qu'ils couvrent la même fenêtre**, y compris quand
   l'autre l'a nommée. « Sur ta fenêtre exacte » dans un rapport ne prouve pas que le calcul l'a
   respectée.
2. **La règle de sens a fonctionné.** `hub ≥ transcripts` a signalé le défaut ; j'ai cherché mon
   erreur, ne l'ai pas trouvée, et j'ai eu raison de publier l'anomalie **en la qualifiant
   d'hypothèse** plutôt que de la taire ou de l'affirmer. C'est la vérification croisée qui a
   tranché, pas le raisonnement.
3. **Une explication plausible qui couvre l'écart n'est pas sa cause.** Le trou du relais existait
   bel et bien, l'ordre de grandeur annoncé par po-2023 (~175 servages locaux sur une autre fenêtre)
   semblait coller — et il valait **32**. Un candidat qui explique la magnitude n'est pas validé
   pour autant : demander le comptage, pas seulement l'ordre de grandeur.

---

## Le cycle

### Phase 0 — Cron : garde-fou d'entrée

`CronList`. Si le job `/claudish-coordinate` est absent → le ré-armer **immédiatement** :

```
CronCreate(cron: "37 */3 * * *",
           prompt: "Cycle de coordination du workspace claudish (myia-ai-01, rôle coordinateur). Lis d:\claudish\.claude\skills\claudish-coordinate\SKILL.md et exécute intégralement le cycle qu'il décrit, phases 0 à 7.",
           recurring: true)
```

**Le prompt du cron pointe le fichier, pas `/claudish-coordinate`** — et ce n'est pas cosmétique : un skill créé en cours de session n'est **pas** hot-loadé (vérifié 28/08, `Unknown skill`), et le cron étant session-only, redémarrer pour l'enregistrer le détruirait. La forme par chemin marche dans les deux états.

Le job est **session-only** et **auto-expire à 7 jours**. Une continuation de contexte le perd
silencieusement — **vérifié en direct le 30/08** : `CronList` le donnait présent à ma Phase 7 du
cycle 6, et `No scheduled jobs` quelques minutes plus tard, sans que rien ne le signale.

🔴 **Et c'est un garde-fou qui ne peut pas se déclencher tout seul.** Phase 0 ne s'exécute que si un
cycle démarre ; un cycle ne démarre que si le cron tire. **Quand le cron meurt, le mécanisme censé
détecter sa mort est précisément celui qui vient de mourir.** Seul un événement externe rompt
l'impasse — le 30/08, c'est le user qui a dit « réarme ton cron ». Ne jamais compter sur Phase 0
pour rattraper une perte de cron : elle rattrape une perte *pendant* un cycle, pas la perte du
déclencheur. La seule parade réelle est que le user ou un pair le remarque.

### Phase 1 — Contexte

```
roosync_dashboard(action:"read", type:"workspace", section:"all")   # jamais section:"status" seul
roosync_messages(action:"inbox", status:"all", limit:20)
```

Lire l'inbox **avant** d'écrire quoi que ce soit qui suppose une attente : un go attendu peut déjà y dormir.

⚠️ **L'index inbox démarre froid et ment.** Reproduit sur ai-01 le 28/08 sous test contrôlé : deux appels **à paramètres identiques** (`status:"all", limit:20`), même machine, même workspace, 5 min d'écart → **14 messages** puis **130**. Le premier appel avait masqué 12 messages du 27/08, dont plusieurs HIGH de po-2023. Corrobore le signalement de po-2025 (`0` puis `103`) et écarte l'hypothèse d'un artefact de `limit`.

**Conséquence opératoire : ne jamais conclure « aucun message » sur le premier appel.** Rappeler l'inbox une seconde fois après quelques minutes (typiquement en fin de Phase 2, l'infra servant de temporisation) et comparer le `Total` avant de statuer.

### Phase 2 — Santé infra

```bash
curl -s --max-time 6 http://192.168.0.50:3000/health     # HUB (po-2025) — mon amont réel
curl -s --max-time 6 http://192.168.0.46:3000/health     # RELAIS (po-2023) — maillon de flotte, PAS le hub
curl -s --max-time 5 http://localhost:3002/health        # sidecar
docker ps --format '{{.Names}}\t{{.Status}}'
docker image inspect claudish-claudish-proxy --format 'created={{.Created}}'
```

Lecture :
- `uptimeSec` **près de zéro** = vrai redémarrage. Un `uptimeSec` qui *recule* sans repartir de zéro = pas d'un restart mais d'un pas NTP.
- 🔴 **Un redémarrage de conteneur se diagnostique à l'échelle de l'HÔTE, jamais depuis le conteneur seul.**
  `ExitCode=0`, `OOMKilled=false`, `RestartCount=0` et « non recréé » sont **exactement** ce que produit
  un daemon qui arrête tout proprement : ils ne discriminent **rien**. Le 30/08 j'en ai conclu « `docker
  restart` délibéré sans auteur » et j'ai envoyé po-2023 enquêter sur sa propre tâche ; les **38**
  conteneurs de l'hôte avaient un `StartedAt` tenant dans **0,4 s**. Toujours commencer par :
  ```bash
  docker ps -q | xargs -r docker inspect --format '{{.State.StartedAt}}  {{.Name}}' | sort
  ```
  Groupés = événement daemon/hôte → remonter à l'hôte (`(Get-CimInstance Win32_OperatingSystem).LastBootUpTime`,
  puis System log ids `41` Kernel-Power / `6008` / `1074`, et le provider `nvlddmkm` — ai-01 fait tourner
  vLLM sur GPU : 189 événements pilote en 1,5 s ont provoqué un hard hang le 30/08, `Bugcheck=0`, sans dump).
  Isolé = action ciblée, et **seulement là** la question « qui ? » a un sens.
- Sidecar `/health` **sans** `activeStreams` = image antérieure à #37 → court-circuit 429 et failover absents.
- Un fichier récent dans `D:\claudish-captures` prouve seulement que la requête a été **servie localement**, ce qui recouvre **deux** cas : (a) le sidecar était en AUTONOMOUS, (b) un échec de forward **isolé**, servi localement au compteur `[1/2]`, sans jamais franchir l'hystérésis — le sidecar est resté NOMINAL. **Une capture ne prouve donc PAS un basculement.** Corrigé le 28/08 après m'être trompé sur ce point dans ce runbook même : la capture de 03:17:51Z était un `AbortError` isolé en pleine santé du hub.
- **Le discriminant est le log, jamais le fichier.** Trancher avec :
  ```bash
  docker logs claudish-sidecar --since 14h --timestamps 2>&1 | grep -E "\[Relay\] (upstream|forward failed)"
  ```
  **Compter les épisodes, pas seulement les repérer** : un `DOWN` isolé et quatorze bascules en
  47 min ne se lisent pas pareil. Le 28/08 19:47:30Z→20:42:51Z : **14 `DOWN` / 14 `NOMINAL`**, chaque
  `DOWN` tombant **21-33 s** après le retour précédent — soit les deux premières sondes suivantes.
  Mécanique : `HEARTBEAT_INTERVAL_MS=10_000`, `HEARTBEAT_TIMEOUT_MS=4_000`, `FAIL_THRESHOLD=2`
  (`relay.ts`) → 20 s suffisent. **Ce n'était pas une mort du hub** : la sonde profonde (appel modèle
  complet jusqu'à `message_stop`) a réussi 14 fois dans la même fenêtre, le hub servait ma session
  en continu et répondait à po-2023 à 19:55:36Z. Une bascule mesure la **latence/joignabilité** du
  hub, pas sa vie. Ne pas rapporter « le hub est tombé N fois ».
  ⚠️ **Un épisode peut naître de l'hôte LOCAL, pas du hub.** Le heartbeat tourne dans un conteneur
  sur cette machine : ses timers subissent l'hôte avant le réseau. Une machine qui se dégrade produit
  des `DOWN` indiscernables de ceux d'un hub lent. Avant d'attribuer au hub, vérifier l'hôte sur la
  **même fenêtre**. Ne pas remplacer une attribution fausse par une autre : si rien n'est prouvé,
  écrire « attribution hub non établie », pas « c'était l'hôte ».
  **Causes externes connues à écarter d'abord** : le **restart quotidien drainé du hub à 02:00Z**
  (conteneur reparti ~02:02:47Z) encadre un épisode de ~75 s — attendu, bénin, à ne PAS compter.
  **La compaction nocturne du hub est une fenêtre récurrente de charge** : `compaction.log` (visible
  sur le partage SMB) montre un run **chaque nuit de 00:47:02Z à ~02:04-03:05Z** (7z de ~22 Go →
  ~270 Mo, mesuré 12/09 : 2 h 18, 13/09 : 1 h 17). Les deux épisodes AUTONOMOUS du sidecar ai-01 du
  14/09 (01:03:12Z, 71 s ; 02:02:06Z, 64 s) tombent dans cette fenêtre — le premier a pour candidat
  la charge I/O de la compaction (timing concordant, **non prouvé**), le second le restart drainé.
  Avant d'ouvrir une enquête sur un épisode 00:47→03:05Z : lire `compaction.log`, vérifier que le run
  couvre l'heure de l'épisode, et qualifier « candidat compaction, non prouvé » plutôt qu'attribuer.
  `DOWN after 2 failure(s) → AUTONOMOUS` puis `healthy again → NOMINAL` borne un vrai épisode ; `served LOCALLY [1/2 before AUTONOMOUS]` est un incident isolé sans basculement. Rapprocher ensuite chaque épisode d'une cause externe (deploy, restart drainé, crash backend Docker, reboot hôte) — un épisode **sans** cause identifiée est le seul qui mérite une enquête.

### Phase 3 — Trafic et leak-policy

```powershell
.\scripts\traffic-live.ps1 -Hours 12 -Container claudish-sidecar
```

⚠️ **`-Hours N` n'est pas la fenêtre obtenue.** `--since` étant écarté par le GOTCHA #2, la fenêtre est
approximée par `--tail Hours×8000` — le débit du **hub** en pointe. Sur ce sidecar (~170 lignes/jour),
`-Hours 12` a rendu **186,6 h** (8 jours) sous un en-tête « last 12h ». PR #69 affiche le span réel ;
en attendant, lire la ligne de span, jamais l'en-tête. po-2023 a re-mesuré : `--since` fonctionne
aujourd'hui des deux côtés, le contournement a survécu deux mois à sa cause.

Le `-Container` est **obligatoire ici** : le défaut du script est `claudish-proxy` (le nom du hub), et sur ai-01 il sortirait `No such container` avec exit 1.

🔴 **Le log du sidecar ai-01 a ROTATIONNÉ, et Docker sert le vieux fichier À LA PLACE du courant.**
Diagnostiqué 2026-09-06 (cycle 25) — **remplace l'attribution « skew d'horloge ~81 s » du cycle 24,
qui était fausse.** Le driver `json-file` a deux fichiers : l'ancien s'arrête à **2026-09-05T21:45:05Z**
(le crash hôte), le courant va jusqu'à maintenant. Docker ne les concatène pas — selon la façon dont
on lit, on obtient l'un **ou** l'autre, sans le moindre avertissement :

| Lecture | Fichier servi | Verdict |
|---|---|---|
| `--tail N`, **N ≲ 800** | **courant** — jusqu'à la seconde présente | ✅ **le seul mode fiable** |
| `--tail N`, N ≳ 1000 | **ancien** (915 lignes, fin 21:45:05Z) | ❌ silencieusement périmé |
| `--since <durée>` | **ancien** | ❌ silencieusement périmé |
| dump complet (sans `--tail`) | **ancien** | ❌ silencieusement périmé |

**Règle opératoire : sur ce conteneur, lire UNIQUEMENT avec `--tail N`, N ≤ 800.**
⚠️ **Attribution corrigée le 07/09** : po-203 a restarté son conteneur **deux fois** (16:27Z reboot,
19:40Z rotation clé) et son `--since` est resté intact des deux fois — « la recréation de conteneur »
n'est donc PAS le facteur. Le clivage mesuré est **po-2025 + ai-01 (défectueux) vs po-203 (sain)**,
les trois hôtes ayant rebooté le 06/09 ; la cause (version Docker Desktop, distro WSL2, log-driver,
disque ?) reste non identifiée. La règle opératoire ci-dessus tient inchangée sur ai-01 : le défaut
s'y est reproduit après **chaque** restart (16:25Z, 18:19Z, 22:07Z — 3 époques, 3 fois `--since` vide).
 Un `--since`, un
dump nu ou un `--tail` trop généreux rendent un segment mort daté d'avant-hier, qui *ressemble* à une
queue de log normale.

⚠️ **Le piège se referme sur les deux extrémités du raisonnement, vérifié en direct ce cycle** :
1. J'ai d'abord conclu « le log est **mort** depuis le restart » — dump complet et `--since`
   s'arrêtaient tous deux à 21:45:05Z alors que le conteneur servait et écrivait des captures. Un
   `--tail 3` a rendu des lignes de **10:46Z le jour même** : la conclusion était fausse, et je
   l'aurais publiée sans ce test.
2. Puis j'ai compté 14 `forward failed` et 17 `AUTONOMOUS` sur un `--tail 2000` — **c'étaient les
   épisodes de l'ancien fichier**, présentés comme ceux du jour. Le même `grep` sur `--tail 800`
   donne **1 épisode et 10 replis**. Un compte tiré du mauvais segment est faux sans jamais avoir
   l'air suspect.

Ne trancher qu'après avoir **borné la fenêtre effectivement lue** : `--tail N | awk 'NR==1{f=$1} END{print f" -> "$1}'`.

🔴 **Conséquence sur `claudish_traffic` (MCP roo-state-manager) : il rend un FAUX NÉGATIF ici.** Il
collecte via `docker logs --timestamps --since <durée>` → donc l'ancien fichier → et a conclu
« **NOMINAL (silent): 0 requests in window on a reachable container. Silence is not a failure** »
alors que **10 requêtes avaient été servies localement** sur la fenêtre. Son garde-fou « GAP: traffic
STOPPED at <ts> » **ne s'est pas déclenché** : il a signalé « 5m missing at the head » mais rien sur
le fait que sa ligne la plus récente avait **13,4 h de retard** sur l'heure courante. Signalé à
roo-extensions (propriétaire de l'outil) — relayer, ne pas instruire. En attendant, **ne pas prendre
son verdict NOMINAL pour argent comptant sur ai-01** : le croiser avec `--tail 800` et avec les
captures.

Ce que ce défaut a déjà coûté : le 05/09 j'ai publié « le sidecar tourne juste sous le seuil de 30 s »
depuis un `--tail 12`. **Rétracté.** Aucune mesure de latence post-reboot n'était disponible ce jour-là.

🔴 **Ne JAMAIS rendre un verdict de leak-policy depuis les logs du sidecar.** En NOMINAL le relais
retourne avant `logRequest` : le log local est **structurellement muet sur mon propre trafic**, et
`ANTHROPIC_BASE_URL` pointe le hub — donc rien de ce que j'émets ne passe par mon sidecar. Le 28/08
j'ai publié « 0 modèle Anthropic facturable côté ai-01 » en citant ces logs, **quinze lignes après**
avoir écrit dans le même rapport que le relais NOMINAL ne journalise rien. Mesure hub réelle sur la
même période : **581 Opus natives depuis `machine=myia-ai-01` en 3 h**. Un zéro local mesure ma
cécité, pas ma consommation. **La seule source valide est le hub** — ⚠️ **po-2025 depuis le 05/09,
plus po-2023**, et ce hub a désormais un **trou connu** (voir Topologie : +169 le 05/09, tout ce que le
relais sert localement lui échappe). Le hub reste la meilleure source ; il n'est plus une source
exhaustive. Ce que je peux produire
ici et que le hub ne peut pas : la **ventilation par lane**, depuis les transcripts de
`~/.claude/projects/*/`.

🟢 **Depuis le 08/09, le corpus du hub est lisible DIRECTEMENT depuis ai-01** — le verdict de
leak-policy ne dépend plus d'un rapport de po-2025. Deux chemins, **lecture seule, aucun geste** :

| chemin | contenu | usage |
|---|---|---|
| `\\192.168.0.50\d$\claudish-captures` | captures **vivantes** du hub | verdict du jour |
| `G:\Mon Drive\Backups-Cloud\claudish\captures-YYYY-MM-DD.7z` | 93 jours d'archives nocturnes | historique, comparaisons |

⚠️ **Le discriminant « facturé Anthropic » est le backend qui a SERVI, pas le modèle demandé.**
`resp-*-native-*.sse` = api.anthropic.com ; tout le reste est du forfait. Un `claude-sonnet-5`
demandé par six machines est servi `openai-glm-5.3` — **zéro** réponse `native-sonnet`/`native-haiku`
dans tout le corpus. Lire le nom demandé comme une facture Anthropic est le faux positif type.
Le champ d'attribution est dans les **300 premiers octets** de chaque `req-*.json` :
`{"ts":…,"src":…,"machine":…,"model":…` — jamais besoin du corps.

Trois pièges mesurés le 08/09 :
1. **Les captures ne contiennent aucun retour ligne réel** : `7z e -so … | grep` tente de charger
   17 Go **comme une seule ligne** (4,2 Go de RSS, zéro sortie). Lire par blocs binaires.
2. **Le compteur `rNNNN` se réinitialise à chaque redémarrage du proxy** (26 462 fichiers pour des
   index n'allant qu'à 14 020) : apparier `req`↔`resp` par index seul donne 3-4 candidats,
   **l'horodatage tranche**.
3. **Le nom d'archive ne porte pas la machine** : le jour du cutover, deux machines ont déposé
   `captures-2026-09-05.7z` et GDrive a renommé l'une en `(1)`. Identifier par le **contenu**
   (l'archive du hub porte plusieurs tags `X-Claudish-Machine`). C'est l'argument de `-ArchivePrefix`.

**Contrôle de complétude obligatoire** : en-têtes extraits == fichiers `req-*` annoncés par `7z l`.
🔴 **Limite à déclarer avec tout chiffre** : ce corpus ne voit que ce qui **atteint le hub**. Écrire
« aucun trafic Anthropic ailleurs **à travers claudish** », jamais « aucun trafic Anthropic ailleurs ».

4. **Le seau `machine=""` est un angle mort de conception, pas du bruit de scan.** `forwardToUpstream`
   (`fork/server/relay.ts` ~l. 160-170) **préserve** `X-Claudish-Machine` mais ne le **pose** jamais :
   un client qui n'émet pas l'en-tête (SDK avec une simple `base_url`) atteint le hub non attribué,
   quelle que soit sa machine. Mesuré le 08/09 : **990 req sans machine** sur 12 988.
   ➜ **Avant de publier un verdict leak-policy, vérifier que ce seau ne contient aucun Opus** — c'est
   ce contrôle, et lui seul, qui rend le verdict valide malgré l'angle mort. Détail :
   memory `relay-preserves-machine-header-never-stamps-it`.

**Deux pièges d'instrument, rencontrés tous les deux le 29/08 :**

1. **Compter les lignes n'est pas compter les requêtes.** Une lane contient `<uuid>.jsonl` *et* des
   `agent-*.jsonl` de sous-agents, qui **rejouent les mêmes `message.id`**. Ratio mesuré : **2,46**
   (7845 lignes → 3192 requêtes). Mon `805` publié était un comptage de lignes ; dédupliqué il vaut
   **310**, contre **315** aux logs du hub. Toujours terminer par
   `| grep -oE '"id":"msg_[A-Za-z0-9]+"' | sort -u | wc -l`.
2. **Le transcript écrit `"model":"claude-opus-5"`, SANS le suffixe `[1m]`** — celui-ci n'est qu'un
   alias de `settings.json`. Un motif portant le suffixe rend **0 sur 201 842 lignes, en silence**.
   Établir le motif par `grep -rhoE '"model":"[^"]*"' --include='*.jsonl' . | sort | uniq -c | sort -rn`
   **avant** de compter, jamais de mémoire.

**Sens attendu de l'écart : hub ≥ transcripts** — le hub compte retries et échecs, le transcript
n'enregistre que les réponses abouties. Un total transcript **au-dessus** du hub est un défaut de
méthode, pas une découverte. C'est ce renversement de signe qui aurait dû m'alerter sur le 805.

**Politique de dépense Opus (user, 31/08) — c'est elle qui définit ce qu'est un leak ici.**

Opus est **cantonné aux 5 lanes coordinatrices d'ai-01** :

| lane | raison |
|---|---|
| `d--CoursIA` | projet flagship |
| `d--roo-extensions` | le harnais |
| `d--2025-Epita-Intelligence-Symbolique` | doit lander bientôt, se distille dans CoursIA puis passe le relais |
| `d--Argumentum` | pré-release qui s'éternise |
| `d--claudish` | coordination (ce workspace) |

**Tout le reste = Sonnet/GLM ou Haiku/MiniMax avec leurs failover respectifs** (quelques `gpt sol`
sur po-2025). L'enveloppe est **élastique** : elle dépend des crédits hebdo, et **il n'existe pas de
sonde fiable sur tous les providers** — donc ne jamais présenter un plafond comme mesuré. Une lane
peut être promue **ponctuellement** « pour sortir la tête de l'eau » : une 6e lane Opus n'est donc
pas automatiquement une faute, mais elle doit être **signalée et datée**.

🔎 **Le leak à surveiller ici n'est PAS `cc_is_subagent=true`** (ça, c'est la fuite inter-machines).
C'est **l'Opus non désiré sur une lane d'ai-01** : lane qu'on a oublié de rétrograder, ou
**contamination via l'UI Claude Code, qui propage volontiers un changement de modèle** d'une session
à l'autre.

**Signature à chercher** — une bascule, pas un mélange : la lane tourne 100 % GLM/DeepSeek pendant
des jours, puis passe **100 % Opus** à partir d'une heure donnée et n'y revient plus. Détection :

```bash
cd /c/Users/MYIA/.claude/projects
for d in */; do
  n=$(grep -rhE '"timestamp":"<JOUR>T' --include='*.jsonl' "$d" 2>/dev/null       | grep '"model":"claude-opus-5"'       | grep -oE '"id":"msg_[A-Za-z0-9]+"' | sort -u | wc -l)
  [ "$n" -gt 0 ] && echo "$n|$d"
done | sort -t'|' -rn        # toute lane hors des 5 = à investiguer
```
puis ventiler par heure (`model` × heure) pour distinguer **bascule** de trafic mixte, et compter
les `agent-*.jsonl` : **0 fichier agent = session interactive**, donc contamination UI et non
sous-agent rogue.

🔴 **Burst ou mur : `upstream-errors.log` tranche, et la cascade ne couvre QUE le mur.**

Un 429 rendu au client n'est pas un argument d'armement de cascade tant qu'on n'a pas lu son
**corps**. `isQuotaExhaustion` est délibérément plus étroit que le retry : un 429 n'arme la cascade
que si le corps nomme un mur de quota/plan/crédit. Le discriminant est dans
`D:\claudish-captures\upstream-errors.log`, une ligne JSON par réponse upstream non-ok :

| code | corps | nature | cascade ? |
|---|---|---|---|
| `1308` | `Usage limit reached for 5 hour. Your limit will reset at …` | **mur** | ✅ arme |
| `1302` | `Rate limit reached for requests` | **burst** de concurrence | ❌ n'arme pas |

Mesuré le 06/09 à 16:54:49Z : 2 requêtes mortes sur `1302` après « ladder exhausted after 5 retries /
60.0s asleep ». **Armer la cascade ne les aurait pas sauvées.** Le dashboard flotte présentait
jusque-là « 2 tours perdus → armer la cascade » comme un seul dossier ; il notait pourtant lui-même
que les 2 pertes du 05/09 étaient « un 429 burst, un 429 mur plan » — soit **une sur deux** couverte.

Chaîne causale complète de l'épisode 06/09, lisible de bout en bout : repli `header-timeout after
30000ms` → 2 requêtes servies **localement** à 66 ms d'écart → concurrence locale → `1302` → échelle
épuisée en 60 s → 429 au client. Le déclencheur est la **lenteur du chemin relais** (4 replis en
3 min), l'amplificateur est **notre propre concurrence**. Deux leviers réels, dont **aucun n'est la
cascade**. Rapporter « N requêtes rendues en 429 », pas « N agents morts » : des requêtes ont réussi
9 s plus tard, et la récupération éventuelle du SDK au-dessus n'est pas visible d'ici.

**Rien de « hard » n'est demandé pour l'instant** (verbatim user). Signaler, dater, suivre d'un
cycle sur l'autre. Le vrai correctif est le **routage intelligent déjà spécifié** — question directe
au LLM sur les capacités nécessaires avant chaque condensation, puis switch — à implémenter *quand
on sera prêt*, pas maintenant.

Cas fondateur : lane `d--qdrant`, 31/08 — 0 Opus du 29/08 au 31/08 08h, puis 100 % Opus à 09h, 11h
et 17h (31 req dédup, 1,5 % du jour). Session interactive, 0 `agent-*`.

**Leak-policy Anthropic** (Opus / Fable / Sonnet) : `ai-01` = `[OK]` · `po-2025` = `[REVIEW]`, workflow Safari/agent-sdk possiblement autorisé → **demander au user avant de parler de fuite** · toute autre machine = `[LEAK]`. La signature d'une vraie fuite est `cc_is_subagent=true`, qui vit **dans le corps de la requête**, pas dans stdout : `docker logs` seul ne peut pas la voir.

### Phase 4 — Dépôt et PRs

```bash
git fetch origin && git status -sb && git log --oneline origin/main -5
gh pr list --repo jsboige/claudish --state open --json number,title,headRefName,createdAt
```

- Comparer `main` local à `origin/main` : le pair merge de son côté, un diff contre une ref non fetchée est un diff contre le passé.
- **Chercher les collisions** : tous les agents poussent sous `jsboige`. Deux PRs qui touchent les mêmes fichiers = doublon probable (cas #63/#64, 27-28/08). Comparer les `files`, pas les titres.
- **Avant tout merge/review** : lire le body complet, tous les commentaires, toutes les reviews avec leur `state`, et le diff. Ne pas merger sur un `CHANGES_REQUESTED` non adressé. Il n'y a **aucun gate CI** sur ce dépôt (le seul check est un no-op) : « en attente de CI » est un faux bloqueur, les tests locaux font foi.

### Phase 5 — Arbitrages au user

Pour chaque décision pendante, donner assez de contexte pour trancher **sans ouvrir GitHub** : ce que ça change concrètement, risque si approuvé, risque si rejeté, recommandation. Représenter les arbitrages différés au cycle suivant tant qu'ils ne sont pas tranchés.

**Registre des questions ouvertes (gouvernance user 15/09)** : toute question ou askuser non bloquant vit dans `C:\Users\MYIA\.claude\projects\d--claudish\memory\open-questions-ledger.md` (+ scratchpad à présenter si matériel). Une entrée n'en sort **que sur réponse user** — jamais auto-expirée. Le registre est représenté à chaque fin de cycle (Phase 6), de façon non bloquante : on n'attend jamais une réponse pour exécuter. Les outils plan-mode/`AskUserQuestion` sont deny dans `settings.json` (ordre user 15/09) — ne pas les contourner ; les notebooks passent par le MCP papermill maison, activé au besoin.

### Phase 5b — Contrôle des gestes (mandat user 07/09)

**Arbitrage user du 07/09 (~16:00 locale), après l'incident hub po-2025** (flotte à l'arrêt par bind EISDIR, puis cascades vidées par un `up -d` de réparation) : le coordinateur **valide ex-ante tout geste infra/trafic du workspace**, urgence exceptée (validée ex-post). La règle lie toutes les machines, coordinateur compris.

- **Gate ex-ante** : tout geste (recreate/restart de conteneur, `.env`/config, cutover/routage, onboarding provider, probe consommant du budget) = `[PROPOSAL]` dashboard AVANT exécution (objectif, commandes exactes, rayon d'impact, rollback, état vérifiable attendu) → attendre mon `[ACK]`. **Chaque cycle : scanner les `[PROPOSAL]` en attente et trancher** — un ACK tardif de 6h bloque un pair, dire « ACK sous réserve de X » quand le geste est sain mais incomplet.
- **Urgence** : flotte à l'arrêt / tours perdus → agir d'abord, `[INCIDENT]` + post-mortem avec preuves ≤ 1h, validation ex-post. Le post-mortem hub du 07/09 14:01Z (chaîne racine vérifiée, pièges, état vérifié) est le format de référence.
- **Preuves post-restart/recreate hub (≤ 15 min)** : ligne startup `[Failover] configured=N auto=on` + `/health` + `test -f` sur chaque bind fichier + relay NOMINAL constaté po-203.
- **Manifeste de flotte** (`docs/deployment/fleet-state.md`, non-secret, versionné) : par machine — image, upstream, ports, capture, cascades (étapes verbatim, jamais de secrets, empreintes 8 ch.), dernière vérif. Tout changement d'état armé = commit du manifeste + note dashboard. C'est la surface qui donne au coordinateur l'accès aux configs exigé par le mandat. ⚠️ **Portée réduite le 08/09** : l'**attribution du trafic** hub ne passe plus par la déclaration (voir Phase 3, corpus lisible en SMB) — le manifeste reste le mécanisme pour ce qui n'est pas dans les captures, c'est-à-dire l'**état armé des cascades**, qui ne se prouve que par la ligne de démarrage `[Failover] configured=N auto=on` du conteneur distant. Ne pas lire le `.env` d'une machine tierce pour y suppléer : il porte la clé proxy du cluster, et un fichier sur disque **ne prouve pas** l'env d'un conteneur déjà démarré.
- **Validation ex-post ≠ répétition du self-report** : vérifier indépendamment tout ce qui est mesurable depuis ai-01 (`/health` hub/relais/sidecar, logs sidecar, trafic), exiger les preuves déclaratives pour le reste, jamais de probe budget sans GO user.

### Phase 6 — Publication

Ordre **obligatoire** : commit + PR **puis** le rapport. Ne jamais annoncer un travail non commité.

```
roosync_dashboard(action:"append", type:"workspace", content:"[DONE] ...")
```

Les rapports vont sur le dashboard, **pas** dans des fichiers du dépôt.

Le bilan **représente le registre des questions ouvertes** (entrées en attente, non bloquant) — section obligatoire tant que le registre n'est pas vide.

### Phase 7 — Cron : garde-fou de sortie (CRITIQUE)

**Avant de poster le bilan et de s'endormir**, re-vérifier `CronList`. C'est le dernier moment où une perte de job en cours de cycle peut être rattrapée. Logger `cron présent` ou `cron ré-armé` dans le bilan.

**Invariant : ne jamais s'endormir sans cron armé.**

⚠️ **Nécessaire, pas suffisant.** Le 30/08 la Phase 7 a validé « cron présent » et le job a disparu
ensuite. Cette phase garantit qu'aucune perte *survenue pendant le cycle* ne passe ; elle ne peut
rien contre une perte postérieure. Ne pas en tirer une assurance : écrire dans le bilan « cron
vérifié présent **à cette heure** », jamais « cron garanti jusqu'au prochain cycle ».

---

## Pièges vérifiés — ne pas les réapprendre

- **Ne jamais recréer le container qui porte mon propre trafic.** Un `docker compose up --force-recreate` sur `claudish-sidecar` coupe la session en cours. Passer `docker compose config` avant tout recreate, et vérifier que les variables (failover notamment) survivent.
- **Docker recrée un bind fichier manquant en répertoire** (incident hub 07/09) : après tout crash Docker, `test -f` sur chaque source de bind fichier avant de remonter — sinon EISDIR silencieux dans le conteneur (les 401 Codex venaient de là, pas d'un refus d'entitlement).
- **Un plain `up -d` recharge le `.env` du répertoire du compose** — pas celui du déploiement réel : le `up -d` de réparation du 07/09 a monté les cascades VIDES (le `.env` du checkout ne portait qu'une ligne). Tout recreate porte `--env-file` explicite ; vérifier la ligne `[Failover] configured=N` au startup après coup.
- **Un conteneur « Created » n'est pas « running »** : le hub du 07/09 est resté Created-never-started (OCI « not a directory », bind fichier-sur-répertoire) alors que la réparation semblait acquise. `docker ps` filtre les Created par défaut — `docker ps -a` + `/health` font foi.
- **Un restart tue les SSE en vol.** Utiliser `scripts/claudish-drain.ps1`, jamais `docker restart` nu. Le `N in flight` du `drain.log` est un **minorant**, et ce log est en heure **locale** (+2 vs UTC).
- **La section « status » du dashboard est une synthèse, jamais une source.** La condensation a déjà fabriqué des faits (une PR annoncée mergée deux fois, contredite 40 lignes plus bas). Vérifier sur la source avant de propager.
- **Ne pas conclure « DOWN » sur un silence.** L'absence de réponse d'un pair n'est pas une panne.
- **Un code retour n'est pas un diagnostic** : `rc=28` couvre « hôte éteint » comme « appli muette ». Un label de log n'est pas une taxonomie de pannes.
- **NOMINAL ⇒ ~0 requête locale** : sur un sidecar relayant, l'analyse de trafic locale est aveugle par construction. Zéro n'est pas un script cassé.
- **`codebase_search` est indisponible sur ce workspace** (aucune collection Qdrant pour `d:/claudish`). Grounding = technique (Read/Grep/Git) + conversationnel (`conversation_browser`). Ne pas boucler dessus.
- **La session précédente pèse ~44 Mo** : ne jamais la lire en entier. `conversation_browser` avec `smart_truncation:true` et bornes `messageStart`/`messageEnd`.

## Hors périmètre

Console Mistral / Qwen / OpenAI (inaccessibles aux agents → question au user) · arbitrages de coût et de souscription · reboots de machines tierces · bugs harness d'autres workspaces (relayer, ne pas instruire).
