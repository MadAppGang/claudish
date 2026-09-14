---
name: claudish-migration-watch
description: Surveille la préparation de migration du hub Claudish de po-2023 vers po-2025, actualise la matrice P0 et publie un bilan sans toucher à l'infrastructure.
---

# Surveillance migration hub Claudish

Cycle de surveillance local au workspace `claudish` pour la migration envisagée du hub de `myia-po-2023` vers `myia-po-2025`.

## Sources à lire

1. Lire le dashboard `workspace-claudish`, `section: "all"`.
2. Lire l'inbox RooSync de `myia-po-2025:claudish`.
3. Ne retenir que les **nouveaux deltas vérifiés** provenant de po-2023, ai-01, po-2024, po-2026 ou du workspace Maintenance.
4. Distinguer strictement dans la matrice :
   - **VÉRIFIÉ** : preuve directe ou mesure opérateur explicite ;
   - **RAPPORTÉ** : information non encore recoupée ;
   - **À EXPORTER** : artefact formel encore manquant.
5. **Dérive de consommation (1× par cycle)** : relancer l'organe de tendance sur la semaine écoulée —
   `python scripts/native-trend.py --days <J-7> <hier> [--loose-dir D:\claudish-captures --loose-date <aujourd'hui>] --keep`
   depuis un scratchpad (réutilise les dirs `nat-*` déjà extraits, sinon extraction auto depuis `G:\Mon Drive\Backups-Cloud\claudish`).
   Alerter en `[WARN]` si `OUT/req` dépasse **+25 % sur 7 jours** ou si les compactions/jour font plus que doubler ; les colonnes de contrôle (`ctx/req`, `%cr`) plates + `n` plat signifient « la dérive est dans ce que le modèle écrit », pas dans la lecture. Un `[LEAK]` reste du ressort de `native-consumption.py` (colonne machine + `sub`).
6. **Tant que l'alerte dérive est active (mandat user 14/09)** : prolonger l'analyse d'un grain par cycle ET pousser une préconisation mesurée **directement à la lane CoursIA en vol** — DM `myia-ai-01:CoursIA` + relais dashboard CoursIA (pattern DM-reliability). La lane ajuste au fur et à mesure. Objectif : revenir au rythme de début juillet — **plus de dispatch aux workers, plus de merges, moins de tokens**. Cibles KPI (juillet → 13/09 → cible) : merges/j 105-115 → 85 → **≥ 110** · MERGE/resp 0,09 → 0,03 → **≥ 0,06** · cmd/resp 0,59 → 1,62 → **≤ 0,8** · gh/200 resp 99 → 218 → **≤ 120** · PRs distinctes/200 resp 78 → 168 → **≤ 100** · OUT/req ~2,4-2,6 k → 6 307 → **≤ 2 600**. Ne pas durcir refs/PR (plate 1,9-3,2 : la profondeur de relecture n'est pas le levier). Leviers par rendement : merger par lots · dispatcher l'audit aux lanes · ne pas re-poller avant l'échéance du plancher DWELL · une conclusion par PR auditée · bornes verbosité client.

## Arbitrages user en vigueur (31 août 2026)

- **ai-01** : le bypass du sidecar est délibéré, car son relai avait été constaté défaillant. Le client reste direct sur l'IP du hub. Aucun repointage vers `localhost:3002` avant une batterie de tests renforcée : image à jour, NOMINAL prouvé par absence de `[Request]` locale, egress depuis le conteneur, attribution hub préservée, tour Opus natif réel depuis Claude Code, failover AUTONOMOUS + hystérésis, never-hang mid-stream et cascade locale armée.
- **po-2026** : corriger le sidecar oublié selon **stop & repair, never workaround**. Une éventuelle décommission complète doit être proposée explicitement au user, jamais décidée silencieusement.
- **RAM po-2025** : réglages délégués à l'agent local. Mesurer avant de proposer. Réglage de travail : `memory=16GB`, `swap=16GB`, `autoMemoryReclaim=gradual`, `vmIdleTimeout=-1`. Gates : GO si RAM libre ≥4 Go et commit <90 % ; no-go si RAM ≤2 Go ou commit ≥92 %. Ne jamais appliquer sans fenêtre et validation explicites.

## Matrice P0 à maintenir

- Ancrages directs ai-01 et preuve du futur chemin de bascule/rollback.
- Réparation du sidecar po-2026.
- Baselines RAM active et calme sur po-2025, puis réglages proposés.
- Exports formels IIS/DNS/XML.
- Audit `localhost` / `customEndpoints`, notamment vLLM.
- État source : hub, tâches planifiées, captures, SearXNG, probes, stabilité.

Mettre à jour la mémoire projet `migration-hub-to-po-2025.md` uniquement lorsqu'un delta matériel durable apparaît. Ne pas dupliquer les bilans calmes.

## Garde-fous HARD

- Ne modifier ni `.wslconfig`, ni Docker/WSL, ni les containers, ni le trafic.
- Ne préparer ou exécuter aucun cutover sans validation explicite du user.
- Ne jamais exposer de secret ou valeur de clé ; citer uniquement les noms de variables.
- Ne pas transformer une absence de réponse en validation.
- Un mur quota 402/429/529 n'est pas une panne du hub.

## Rapport de fin

Publier un bref bilan `[DONE][MIGRATION][SURVEILLANCE …]` sur `workspace-claudish` :

- nouveaux deltas vérifiés ;
- changements dans la matrice P0 ;
- blocages ou arbitrages restant réellement ouverts ;
- confirmation explicite que l'infrastructure et le trafic n'ont pas été modifiés.

S'il n'y a aucun delta matériel, publier seulement un bilan calme et ne pas modifier la mémoire.

## Réarmement

Commande manuelle : `/claudish-migration-watch`.

Cron session-only recommandé : toutes les 4 heures à `:47`, avec le prompt réduit à `/claudish-migration-watch`. Vérifier `CronList` avant de l'armer afin d'éviter tout doublon. Le cron expire automatiquement après 7 jours et disparaît au redémarrage de la session.