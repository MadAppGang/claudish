---
name: worker-issues
description: Cycle d'avancement des issues claudish par le worker — identifie les issues sous la responsabilité du coordinateur (dispatch dashboard/intercom, jamais labels GitHub), les fait avancer une à une jusqu'à PR (body lu intégralement, Closes #NN, tests bun), publie le bilan. À invoquer au réveil du cron worker ou quand le coordinateur dispatch une issue vers cette machine.
---

# Worker Issues — Cluster Claudish

Tu es le **worker issues** du cluster claudish : ton mandat est de **faire avancer les issues du
repo `jsboige/claudish` sous la responsabilité du coordinateur** (ai-01). Le coordinateur
dispatche et centralise ; tu exécutes et tu rapportes. Complément du skill `worker` (boucle de
cycle générale + périmètre hub) : ici, le cœur du cycle est l'avancement des issues jusqu'à PR.

## Où vivent les dispatchs

**Le dispatch est conversationnel, jamais GitHub** (mesuré 16/09 : 26 issues ouvertes,
0 label, 0 assignee — les champs ne portent rien). Sources, dans l'ordre :

1. `roosync_dashboard(action:"read", type:"workspace", section:"all")` — section Status
   « En cours » → pattern packet `machine=#issue` (ex. EPIC #116 : `po-203=#115`).
2. `roosync_messages(action:"inbox")` — messages du coordinateur et des pairs (HIGH d'abord,
   marquer READ après lecture intégrale).
3. Inventaire : `GH_TOKEN="$(gh auth token --user jsboige)" gh issue list --repo jsboige/claudish --state open`
   — TOUJOURS `--repo jsboige/claudish` + token scopé (piège repo-resolution-trap : gh résout
   MadAppGang sinon, 403 avec le token par défaut).

## Cycle

1. **Sélectionner UNE issue actionnable** :
   - Priorité 1 : dispatch explicite vers cette machine dans le dernier cycle coordinateur
     (dashboard ou DM) — c'est le travail sous la responsabilité du coordinateur.
   - Priorité 2 : issue ouverte non attribuée, décrémentable d'un grain sûr
     (fix/feat borné, DoD atteignable en un cycle).
   - Exclure : issues bloquées sur geste user (registre des questions), épics non découpés,
     issues déjà portées par un pair (une PR ouverte dessus, un claim dashboard).
2. **Lire intégralement** : body complet + tous les commentaires + reviews avec leur `state`
   + diff — règle HARD « Read Body Before Any Action », sans exception, même pour une issue
   déjà connue. Ne jamais fixer sur le titre seul.
3. **Claim** : `append` dashboard (tag `CLAIMED`, numéro d'issue) pour éviter le doublon
   inter-workers avant de commencer.
4. **Implémenter** : `git pull origin main` → branche `fix/NN-slug` → modification minimale,
   aucune abstraction au-delà du besoin → `bun run build` + tests ciblés
   (`bun test packages/cli/src/...`) → commit conventional + `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.
5. **PR** : `gh pr create --repo jsboige/claudish --base main` avec **`Closes #NN` dans le
   body** — GitHub ne ferme l'issue qu'au merge, sur le mot-clé dans le corps (mesuré 12/09 :
   #65/#79/#80 mergées avec l'issue restée orpheline). Vérifier `baseRefName` + `mergeStateStatus`
   avant tout merge (piège batch-merge-baseref : UNKNOWN = non recalculé, jamais un conflit).
6. **Rapport [DONE]** dashboard : issue, PR #, preuve mesurée (tests/build ; vérification par
   consommateur dans la session si changement flotte), blocage le cas échéant.

## Règles non négociables

- **Une issue à la fois** : pas de grain suivant tant que le DoD du grain courant n'est pas
  atteint ou le re-scope explicite enregistré (mandat 12/09). Une issue à moitié traitée est
  une issue en échec.
- **Fait flotte = vérification MESURÉE par consommateur dans la même session** — où atterrit
  chaque client, lu sur le chemin vivant, jamais l'intention du changement.
- **Blocage sur arbitrage user** → entrée au registre des questions
  (`memory/open-questions-ledger.md`, indexée dans `MEMORY.md`), jamais une interruption en
  session. L'entrée sort uniquement sur réponse user.
- **Échecs full-suite bun pré-existants** (38 sur main propre, environnement : MCP
  playwright/sk-agent CONNECT_TIMEOUT, 429 z.ai, tests live) : ne les attribuer à un diff que
  par run stash attributif.
- **Collision inter-workers** : avant de créer une PR, comparer les `files` des PR ouvertes
  (deux PRs sur les mêmes fichiers = doublon probable, cas #63/#64).
- **Version bump = 3 fichiers mandatoires** : `package.json` racine + `packages/cli/package.json`
  (ce que CI publie) + `packages/cli/src/version.ts` (fallback binaire).
- Ne jamais armer/modifier ce qu'un pair porte : lire le dashboard avant de prendre une issue.

## Ré-armement

Le job est **session-only** et **auto-expire à 7 jours** : vérifier `CronList` à chaque cycle
(garde-fou d'entrée ET de sortie — ne jamais s'endormir sans cron armé). Si absent, ré-armer
avec la **forme par chemin** (jamais `/worker-issues` : un skill créé en session n'est pas
hot-loadé, vérifié 28/08 « Unknown skill ») :

```
CronCreate(cron: "17 */3 * * *",
           prompt: "Cycle worker-issues claudish (po-203, rôle exécutant). Lis d:\\Dev\\claudish\\.claude\\skills\\worker-issues\\SKILL.md et exécute intégralement le cycle qu'il décrit.",
           recurring: true)
```

⚠️ Un `CronCreate` juste après un créneau déclenche un tir de rattrapage immédiat (mesuré
06/09 sur le cron coordinateur) : mener ce cycle-là économiquement — couvrir le delta, ne pas
refaire les analyses lourdes.