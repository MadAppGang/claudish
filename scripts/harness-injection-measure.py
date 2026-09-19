#!/usr/bin/env python3
"""
harness-injection-measure.py -- mesurer ce que le harnais COUTE REELLEMENT en contexte.

Auteur : lane myia-ai-01:claudish. Ecrit pour la lane myia-ai-01:CoursIA
(issues CoursIA#12051 / #12046), qui doit pouvoir refaire la mesure sur ses
propres captures. Une mesure qu'on ne peut pas reproduire est un rapport, pas
un instrument.

    python harness-injection-measure.py <capture_dir> [--since=2026-08-20]
                                        [--workspace=CoursIA] [--machine=myia-po-2023]
                                        [--all-parsers]

--------------------------------------------------------------------------
HUIT PIEGES. Chacun donne un resultat FAUX ET PLAUSIBLE.
--------------------------------------------------------------------------

1) APPARIEMENT. Le nom du fichier reponse porte `r0001`, son en-tete porte
   `reqN=1 pid=1`. Les deux ne coincident PAS en general : une reponse GLM
   peut porter le rang de fichier d'une requete Opus. Apparier par nom de
   fichier donne un ratio ~3,83 ; apparier par (pid, reqN) donne ~2,15.
   Les deux sont credibles a l'oeil nu. Ce script n'apparie que par
   (pid, reqN), lu dans l'en-tete.

2) UNITE. Le ratio produit ici est en CARACTERES INJECTES par token :
   LF (le blob git est deja normalise) et frontmatter YAML retire (il n'est
   pas reinjecte). Un `wc -c` sur un working tree CRLF sur-compte d'un octet
   par ligne, et les accents ajoutent des octets sans ajouter de caracteres.
   Diviser des OCTETS par ce ratio sur-estime les tokens.
   Nommer l'unite, pas seulement la valeur.

3) CACHE. `input_tokens` seul vaut presque toujours ~2 : le harnais est servi
   depuis le cache. Le cout reel est input + cache_creation + cache_read.
   Ne pas sommer les trois fait conclure que le harnais est gratuit. Il ne
   l'est pas : il est paye en OCCUPATION DE FENETRE plutot qu'en facture.

4) CADRAGE WORKSPACE. Chercher le nom du workspace en sous-chaine dans tout
   le corps retient presque tout : ce nom apparait dans les MEMORY.md des
   AUTRES workspaces. Le filtre gardait 178 requetes sur 179 en ayant l'air
   de cadrer. `--workspace` ne matche donc que les CHEMINS annonces par
   `Contents of .../<workspace>/CLAUDE.md`.

5) FRAICHEUR. Ce script mesure une POPULATION DE CAPTURES, pas l'etat du
   disque. Les captures se tarissent des qu'une session ne passe plus par
   le proxy : le classement peut dater de plusieurs heures pendant que les
   fichiers, eux, ont ete edites. Un ecart massif entre `ch med` et la
   taille sur disque est le symptome. La fenetre de captures est donc
   imprimee, et tout fichier dont la mtime est POSTERIEURE a cette fenetre
   est marque `*` : sa ligne decrit un etat revolu.

6) UNICITE DE LA CLE. `(pid, reqN)` n'est PAS unique : dans un container le
   proxy est **pid 1 a chaque redemarrage** et `reqN` repart a 1. Indexer par
   ecrasement perdait 15 captures sur 10 cles, en silence, et pouvait apparier
   la reponse d'une vie de process avec la requete d'une autre -- le croisement
   meme que le piege 1 pretend interdire, revenu par une autre porte. On garde
   toutes les candidates et on tranche par le temps : la requete PRECEDE sa
   reponse. Sans candidate anterieure, on REFUSE d'apparier plutot que deviner
   (d'ou des `non appariees` non nulles : c'est le signal, pas un defaut).

7) POSITION. Le bloc d'auto-chargement n'est PAS garanti en `messages[0]` :
   CC >= 2.1.268 injecte des `<system-reminder>` multiples (instruction
   re-reads, resumes de condensation), et apres une condensation le message
   initial est REMPLACE par le resume -- le harnais est re-injecte plus loin
   dans la conversation. Le chercher uniquement en position 0 excluait une
   population entiere de la mesure : #23 lot 2 a verifie sur l'echantillon
   natif `req-1-9999` que l'appariement passe, que l'usage passe (cache_read
   = 211 963), et que `harness_block()` rendait False -- les lanes natives
   etaient donc majoritairement hors population pour une raison
   STRUCTURELLE, pas par defaut d'appariement. `harness_blocks()` scanne
   donc tous les messages et tous les blocs texte, et rend le NOMBRE de
   blocs trouves avec leur position : un total sans cette ventilation
   recompterait un bloc historique deplace comme s'il etait toujours en 0.

8) OCCURRENCES vs REQUETES. Un meme fichier peut etre injecte PLUSIEURS fois
   dans une conversation (bloc historique re-injecte apres condensation, ou
   deux blocs citant le meme fichier) : le compteur d'occurrences lu comme
   un compteur de requetes sur-declare la population. Corpus hub 15-18/09
   (#23 L2 po-203) : MEMORY.md compte 4 341 occurrences pour 2 459 requetes
   porteuses, soit 1,77 injection par requete. La table per_file rend donc
   les deux compteurs cote a cote -- occ (occurrences, re-injections
   comprises) et req (requetes DISTINCTES ayant porte le fichier au moins
   une fois). Corollaire : la portee d'une mesure se declenche par
   `--machine=<nom>` ; ce champ vit sur l'enveloppe REQUETE, pas sur la
   reponse -- le filtre ne peut donc s'appliquer qu'APRES appariement, et
   une reponse non appariee n'est attribuable a aucune machine. Une machine
   absente du corpus rend 0 paire (controle negatif), jamais "tout".
--------------------------------------------------------------------------
"""
import json
import os
import re
import statistics
import sys
from datetime import datetime, timezone
from collections import defaultdict

FRONTMATTER = re.compile(r"^---\n.*?\n---\n", re.S)
HDR = re.compile(r"^#\s*parser=(\S+)\s+model=(\S+)\s+reqN=(\d+)\s+pid=(\d+)", re.M)
CONTENTS_OF = re.compile(r"Contents of ([^\n]+?)(?: \(([^)]*)\))?:\n")
RESP_TS = re.compile(r"resp-\d+-r\d+-(\d{4}-\d{2}-\d{2}T[\d-]+Z)-")


def capture_ts(ts):
    """`2026-08-20T19-10-11-203Z` -> datetime UTC.

    Le `ts` des captures separe l'heure par des TIRETS, `isoformat()` par des
    DEUX-POINTS. Compares en chaines, `:` (0x3A) > `-` (0x2D) : tout fichier
    modifie dans la meme heure serait marque perime a tort. On parse.
    """
    try:
        return datetime.strptime(ts[:19], "%Y-%m-%dT%H-%M-%S").replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return None


def injected_len(text):
    """Longueur telle qu'INJECTEE : CRLF -> LF, frontmatter YAML retire."""
    t = text.replace("\r\n", "\n")
    m = FRONTMATTER.match(t)
    return len(t[m.end():]) if m else len(t)


def balanced_object(s, start):
    """Extrait l'objet JSON a `start` en equilibrant les accolades.

    Une regex sur "usage" casse sur l'objet imbrique cache_creation.
    """
    depth = 0
    for i in range(start, len(s)):
        if s[i] == "{":
            depth += 1
        elif s[i] == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(s[start:i + 1])
                except json.JSONDecodeError:
                    return None
    return None


def usage_from_sse(text):
    """Retient l'evenement usage le plus complet. Somme les 3 compteurs d'entree."""
    best = None
    for m in re.finditer(r'"usage"\s*:\s*', text):
        brace = text.find("{", m.end())
        if brace < 0:
            continue
        u = balanced_object(text, brace)
        if not isinstance(u, dict):
            continue
        tot = ((u.get("input_tokens") or 0)
               + (u.get("cache_creation_input_tokens") or 0)
               + (u.get("cache_read_input_tokens") or 0))
        if tot and (best is None or tot > best[0]):
            best = (tot, u.get("input_tokens") or 0, u.get("cache_read_input_tokens") or 0)
    return best


def request_text(body):
    """Tout ce qui entre en contexte cote requete, en caracteres."""
    parts = []
    sysf = body.get("system")
    if isinstance(sysf, str):
        parts.append(sysf)
    elif isinstance(sysf, list):
        parts += [b.get("text", "") for b in sysf if isinstance(b, dict)]
    for msg in body.get("messages", []):
        c = msg.get("content")
        if isinstance(c, str):
            parts.append(c)
        elif isinstance(c, list):
            for b in c:
                if isinstance(b, dict):
                    parts.append(b.get("text") or json.dumps(b.get("input", ""), ensure_ascii=False))
    if body.get("tools"):
        parts.append(json.dumps(body["tools"], ensure_ascii=False))
    return "\n".join(p for p in parts if p)


def harness_blocks(body):
    """Tous les blocs d'auto-chargement, OU QU'ILS SOIENT.

    PIEGE 7 : le bloc n'est pas garanti en `messages[0]` -- CC >= 2.1.268
    injecte des system-reminders multiples, et une condensation remplace le
    message initial par le resume (le harnais est alors re-injecte plus loin).
    L'ancienne detection `messages[0].content[0]` excluant les lanes natives
    de la population (preuve #23 lot 2 : `req-1-9999`, appariement et usage
    OK, detection False).
    Rend [(index_message, index_bloc, texte)] pour tout bloc texte portant
    "Contents of " -- l'ordre du scan suit l'ordre de la conversation.
    """
    out = []
    for mi, msg in enumerate(body.get("messages") or []):
        c = msg.get("content")
        texts = []
        if isinstance(c, list):
            texts = [b.get("text") or "" for b in c
                     if isinstance(b, dict) and b.get("type") == "text"]
        elif isinstance(c, str):
            texts = [c]
        for bi, t in enumerate(texts):
            if "Contents of " in t:
                out.append((mi, bi, t))
    return out


def load_requests(cdir, since):
    """Indexe les requetes par (pid, reqN) -> LISTE horodatee, jamais une seule.

    PIEGE 6 : `(pid, reqN)` n'est PAS unique. Dans un container le proxy est
    **pid 1 a chaque redemarrage** et `reqN` repart a 1 : deux vies de process
    produisent les memes cles. Ecraser (`reqs[k] = d`) perdait ici 15 captures
    sur 10 cles, en silence -- et pouvait apparier la reponse d'un process avec
    la requete d'un autre, c'est-a-dire exactement le croisement que le piege 1
    pretend interdire, revenu par une autre porte.
    On garde donc toutes les candidates, et `pick_request` tranche par le temps.
    """
    reqs = defaultdict(list)
    for fn in os.listdir(cdir):
        if not (fn.startswith("req-") and fn.endswith(".json")):
            continue
        m = re.match(r"req-(\d+)-(\d+)-(.+)\.json$", fn)
        if not m:
            continue
        try:
            with open(os.path.join(cdir, fn), encoding="utf-8") as fh:
                d = json.load(fh)
        except Exception:
            continue
        if since and (d.get("ts") or "") < since:
            continue
        reqs[(int(m.group(1)), int(m.group(2)))].append((m.group(3), d))
    for v in reqs.values():
        v.sort(key=lambda kv: kv[0])
    return reqs


def pick_request(candidates, resp_ts):
    """La requete PRECEDE sa reponse : on prend la derniere candidate <= resp_ts.

    Sans horodatage de reponse exploitable, on ne devine pas -- on ne rend une
    candidate que s'il n'y en a qu'une. Deviner reintroduit le croisement.
    """
    if not candidates:
        return None
    if resp_ts is None:
        return candidates[-1][1] if len(candidates) == 1 else None
    avant = [d for ts, d in candidates if ts <= resp_ts]
    if avant:
        return avant[-1]
    return None


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    cdir = sys.argv[1]
    since = next((a.split("=", 1)[1] for a in sys.argv if a.startswith("--since=")), None)
    workspace = next((a.split("=", 1)[1] for a in sys.argv if a.startswith("--workspace=")), None)
    machine = next((a.split("=", 1)[1] for a in sys.argv if a.startswith("--machine=")), None)
    all_parsers = "--all-parsers" in sys.argv

    reqs = load_requests(cdir, since)
    pairs, harness_hits = [], []
    stamps = []          # PIEGE 5 : la fenetre reellement couverte
    cached = 0
    per_file = defaultdict(list)
    per_file_req = defaultdict(set)  # PIEGE 8 : requetes DISTINCTES par fichier
    block_pats = defaultdict(int)  # PIEGE 7 : (nb_blocs, positions) -> requetes
    block_elsewhere = 0            # PIEGE 7 : 1er bloc hors messages[0]
    skipped_unpaired = 0

    for fn in os.listdir(cdir):
        if not (fn.startswith("resp-") and fn.endswith(".sse")):
            continue
        with open(os.path.join(cdir, fn), encoding="utf-8", errors="replace") as fh:
            txt = fh.read()
        # On ancre sur la FORME de l'horodatage, pas sur une liste de parsers :
        # enumerer un vocabulaire, c'est oublier `native` -- soit exactement les
        # reponses natives qu'on mesure (179 non appariees sur 245 au premier jet).
        rm = RESP_TS.match(fn)
        resp_ts = rm.group(1) if rm else None
        h = HDR.search(txt)
        if not h:
            continue
        model, reqn, pid = h.group(2), int(h.group(3)), int(h.group(4))
        # PIEGE 1 : la cle est l'en-tete, JAMAIS le rang du nom de fichier.
        req = pick_request(reqs.get((pid, reqn)) or [], resp_ts)
        if req is None:
            skipped_unpaired += 1
            continue
        # PIEGE 8 : la machine vit sur l'enveloppe REQUETE -- le filtre ne peut
        # s'appliquer qu'ici, apres appariement. Ces exclusions ne comptent pas
        # dans `non appariees`, qui mesure l'echec d'appariement, pas la portee.
        if machine is not None and req.get("machine") != machine:
            continue
        if not all_parsers and not model.lower().startswith("claude"):
            continue  # natives seulement : leur usage est compte par le tokenizer d'Anthropic
        body = req.get("body") or {}
        hbs = harness_blocks(body)
        # PIEGE 4 : cadrer sur le workspace par les CHEMINS ANNONCES dans les
        # blocs harnais, jamais par une recherche de sous-chaine dans tout le
        # corps -- le nom d'un workspace apparait dans les MEMORY.md des autres,
        # et le filtre retenait alors 178 requetes sur 179 en ayant l'air de
        # cadrer. L'UNION des blocs (et non le seul messages[0]) laisse entrer
        # les requetes dont le CLAUDE.md du workspace est annonce dans un bloc
        # re-injecte hors position 0 -- la population naguere invisible.
        if workspace:
            paths = [m.group(1) for _, _, t in hbs
                     for m in CONTENTS_OF.finditer(t)]
            if not any(re.search(r"[\\/]" + re.escape(workspace) + r"[\\/]CLAUDE\.md$", p)
                       for p in paths):
                continue
        u = usage_from_sse(txt)
        if not u:
            continue
        if req.get("ts"):
            stamps.append(req["ts"])
        total_tok, fresh, cache_read = u  # PIEGE 3 : les trois compteurs
        chars = len(request_text(body))
        if chars and total_tok:
            pairs.append((chars / total_tok, fresh, cache_read))
        if cache_read > 0:
            cached += 1
        req_key = (req.get("ts"), pid, reqn)  # PIEGE 8 : identite de requete
        if hbs:
            # PIEGE 2 : unite injectee. Le total PAR REQUETE somme tous les
            # blocs : un bloc re-injecte apres condensation est paye comme le
            # premier, l'omettre sous-compte le portage.
            harness_hits.append(sum(injected_len(t) for _, _, t in hbs))
            block_pats[(len(hbs), tuple(mi for mi, _, _ in hbs))] += 1
            if hbs[0][0] != 0:
                block_elsewhere += 1
            for _, _, t in hbs:
                pos = [(m.start(), m.group(1)) for m in CONTENTS_OF.finditer(t)]
                for i, (start, path) in enumerate(pos):
                    end = pos[i + 1][0] if i + 1 < len(pos) else len(t)
                    per_file[path.strip()].append(end - start)
                    per_file_req[path.strip()].add(req_key)

    if not pairs:
        print("Aucune paire (pid, reqN) exploitable.")
        print(f"  reponses sans requete appariee : {skipped_unpaired}")
        print("  verifier --since= / --workspace= / --machine= (une machine absente")
        print("  du corpus rend 0 paire, pas tout), ou --all-parsers si aucun modele")
        print("  natif n'est capture (un sidecar en mode NOMINAL n'ecrit rien).")
        sys.exit(1)

    ratios = sorted(p[0] for p in pairs)
    med_ratio = statistics.median(ratios)
    print()
    print(f"Paires appariees par (pid, reqN) : {len(pairs)}   (non appariees : {skipped_unpaired})")
    if machine is not None:
        print(f"Portee machine (--machine)       : {machine}")
    print(f"Ratio caracteres injectes / token : mediane {med_ratio:.2f}"
          f"   p10 {ratios[len(ratios) // 10]:.2f}   p90 {ratios[9 * len(ratios) // 10]:.2f}")
    print(f"Reponses servies depuis le cache  : {cached}/{len(pairs)}")
    if stamps:
        print(f"Fenetre de captures couverte      : {min(stamps)[:19]} -> {max(stamps)[:19]}")
    print(f"  input frais median : {statistics.median([p[1] for p in pairs]):.0f} tok")
    print(f"  cache_read median  : {statistics.median([p[2] for p in pairs]):.0f} tok")

    if not harness_hits:
        return
    med = statistics.median(harness_hits)
    print()
    print("Bloc(s) harnais auto-charge(s), en CARACTERES INJECTES"
          " (total/requete, tous blocs)")
    print(f"  mediane {med:.0f} ch  ~= {med / med_ratio:.0f} tok"
          f"   sur {len(harness_hits)} requetes")
    # PIEGE 7 : sans cette ventilation, un bloc deplace par condensation se
    # recompte comme s'il etait reste en position 0 -- et les requetes natifs
    # a bloc hors 0 restaient invisibles (le faux `harness_block() = False`).
    print(f"  1er bloc en messages[0] : {len(harness_hits) - block_elsewhere} req"
          f"   · ailleurs : {block_elsewhere} req (exclus de l'ancienne mesure)")
    pats = sorted(block_pats.items(), key=lambda kv: -kv[1])[:6]
    print("  motifs : " + " · ".join(
        f"{n} bloc(s) @ msg{list(p)} ({c})" for (n, p), c in pats))
    print()
    # PIEGE 5 : une ligne dont le fichier a bouge APRES la derniere capture
    # decrit un etat revolu. On le dit, on ne laisse pas le lecteur le deduire.
    window_end = capture_ts(max(stamps)) if stamps else None
    stale = 0
    print(f"  {'fichier injecte':56s} {'ch med':>8s} {'%':>6s} {'occ':>5s} {'req':>5s}")
    for path, sizes in sorted(per_file.items(), key=lambda kv: -statistics.median(kv[1])):
        sz = statistics.median(sizes)
        mark = " "
        if window_end:
            try:
                mt = datetime.fromtimestamp(os.path.getmtime(path), timezone.utc)
                if mt > window_end:
                    mark, stale = "*", stale + 1
            except OSError:
                pass
        print(f"{mark} {path[-56:]:56s} {sz:8.0f} {100 * sz / med:5.1f}%"
              f" {len(sizes):5d} {len(per_file_req[path]):5d}")
    print()
    print("  occ = occurrences, re-injections comprises (un fichier porte par deux")
    print("  blocs d'une meme conversation compte 2 fois) ; req = requetes")
    print("  DISTINCTES ayant porte le fichier au moins une fois (PIEGE 8).")
    print()
    if stale:
        print(f"  * {stale} fichier(s) modifie(s) APRES la derniere capture "
              f"({window_end:%Y-%m-%dT%H:%M:%SZ}).")
        print("    Leur ligne mesure l'etat d'alors, pas celui du disque. Les captures")
        print("    se tarissent quand une session ne passe plus par le proxy : ce")
        print("    classement peut dater de plusieurs heures. Re-mesurer avant d'agir.")
        print()
    print("  Un fichier absent de cette liste n'a JAMAIS ete injecte : son poids sur")
    print("  disque est hors budget (frontmatter `paths:` qui ne matche pas la session).")
    print("  C'est le critere de selection d'une vague de slimming : le cout injecte")
    print("  mesure, jamais la taille sur disque.")


if __name__ == "__main__":
    main()
