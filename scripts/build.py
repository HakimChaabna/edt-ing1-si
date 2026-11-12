#!/usr/bin/env python3
"""Récupère l'export iCal d'ADE et le convertit en data/events.json pour la page.

Usage :
    ADE_URL_FISE="https://..." ADE_URL_FISA="https://..." python3 scripts/build.py
    python3 scripts/build.py FISE=fise.ics FISA=fisa.ics      # fichiers locaux (tests)

Chaque parcours a son propre export ADE. Les cours communs (même identifiant ADE)
ne sont gardés qu'une fois, avec la liste des parcours concernés dans "tracks".

Uniquement la bibliothèque standard Python, aucune dépendance à installer.
"""
import json
import os
import re
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

PARIS = ZoneInfo("Europe/Paris")
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "events.json"
TYPES = ("CM", "TD", "TP", "EXAM", "DS", "CC")


def fetch(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "edt-ing1-si/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode("utf-8", errors="replace")


def unfold(text: str) -> list[str]:
    """Recolle les lignes repliées (RFC 5545 : une ligne qui commence par un espace continue la précédente)."""
    lines: list[str] = []
    for raw in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if raw[:1] in (" ", "\t") and lines:
            lines[-1] += raw[1:]
        else:
            lines.append(raw)
    return lines


def unescape(v: str) -> str:
    return (v.replace("\\n", "\n").replace("\\N", "\n")
             .replace("\\,", ",").replace("\\;", ";").replace("\\\\", "\\"))


def parse_dt(value: str, params: str) -> datetime:
    value = value.strip()
    if "VALUE=DATE" in params and "T" not in value:
        return datetime.strptime(value, "%Y%m%d").replace(tzinfo=PARIS)
    if value.endswith("Z"):
        return datetime.strptime(value, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
    m = re.search(r"TZID=([^;:]+)", params)
    tz = ZoneInfo(m.group(1)) if m else PARIS
    return datetime.strptime(value, "%Y%m%dT%H%M%S").replace(tzinfo=tz)


def parse_ics(text: str) -> list[dict]:
    events, cur = [], None
    for line in unfold(text):
        if line == "BEGIN:VEVENT":
            cur = {}
        elif line == "END:VEVENT":
            if cur is not None and "DTSTART" in cur:
                events.append(cur)
            cur = None
        elif cur is not None and ":" in line:
            head, value = line.split(":", 1)
            name, _, params = head.partition(";")
            if name in ("DTSTART", "DTEND"):
                cur[name] = parse_dt(value, params)
            else:
                cur[name] = unescape(value)
    return events


def clean_title(summary: str) -> tuple[str, str, str]:
    """'(MATH) Mathématique pour l'ingénieur (CM) CM' -> ('MATH', "Mathématique pour l'ingénieur", 'CM')"""
    s = summary.strip()
    code = ""
    m = re.match(r"^\(([^)]+)\)\s*(.*)$", s)
    if m:
        code, s = m.group(1).strip(), m.group(2)
    kind = ""
    # type en fin de titre, éventuellement répété : "(CM) CM", "TD", "(TP)"
    while True:
        m = re.search(r"\s*\(?\b(" + "|".join(TYPES) + r")\b\)?\s*$", s, re.I)
        if not m or m.start() == 0:
            break
        kind = kind or m.group(1).upper()
        s = s[: m.start()]
    if not kind:
        m = re.search(r"\b(CM|TD|TP)\b", summary)
        kind = m.group(1) if m else ""
    return code, s.strip(" -:") or summary.strip(), kind


EXAM_RE = re.compile(r"^\s*\*+\s*examen\b\s*(?:SI\b)?\s*[-–:]?\s*(.*)$", re.I)
TBC_RE = re.compile(r"\(\s*horaires?\s*(?:a|à)\s*confirm\w*\s*\)", re.I)


def parse_exam(summary: str):
    """'*** Examen SI - Logique ( horaire a confirmer)' -> ('Logique', True). None si ce n'est pas un examen."""
    m = EXAM_RE.match(summary or "")
    if not m:
        return None
    rest = m.group(1)
    tbc = bool(TBC_RE.search(rest))
    title = TBC_RE.sub("", rest).strip(" -–:")
    return (title or "Examen"), tbc


def match_subject(title: str, subjects: dict[str, str]) -> str:
    """Retrouve le code de la matière d'un examen à partir de son nom (tolère accents, pluriels, fautes)."""
    import difflib
    import unicodedata
    def words(s):
        s = unicodedata.normalize("NFD", s.lower())
        s = "".join(c for c in s if unicodedata.category(c) != "Mn")
        return [w.rstrip("s") for w in re.findall(r"[a-z0-9]+", s) if len(w) > 2 or w.isdigit()]
    t = " ".join(words(title))
    best, score = "", 0.0
    for code, name in subjects.items():
        n = " ".join(words(name))
        r = difflib.SequenceMatcher(None, t, n).ratio()
        if n.startswith(t) or t.startswith(n):  # « Logique » / « Logique 1 »
            r = max(r, 0.9)
        if r > score:
            best, score = code, r
    return best if score >= 0.75 else ""


def split_description(desc: str) -> list[str]:
    """Garde uniquement les groupes. Les autres lignes (noms des enseignants) ne sont jamais copiées :
    ce sont des données personnelles, et le site est public."""
    groups = []
    for raw in desc.split("\n"):
        l = raw.strip()
        if not l or l.lower().startswith("(export") or l.lower().startswith("export"):
            continue
        if re.search(r"\bING\b|\bFIS[AE]\b|\bGr(oupe)?\b|\bpromo", l, re.I):
            groups.append(l)
        else:
            continue
    return groups


def build(feeds: dict[str, str]) -> dict:
    now = datetime.now(PARIS)
    keep_from = (now - timedelta(days=21)).date()
    merged: dict[str, dict] = {}
    for track, text in feeds.items():
        for e in parse_ics(text):
            start = e["DTSTART"].astimezone(PARIS)
            end = e.get("DTEND", e["DTSTART"] + timedelta(hours=1)).astimezone(PARIS)
            if start.date() < keep_from:
                continue
            exam = parse_exam(e.get("SUMMARY", ""))
            if exam:
                code, title, kind = "", exam[0], "Examen"
            else:
                code, title, kind = clean_title(e.get("SUMMARY", "Cours"))
            uid = e.get("UID") or f"{start.isoformat()}-{title}"
            if uid in merged:
                if track not in merged[uid]["tracks"]:
                    merged[uid]["tracks"].append(track)
                continue
            groups = split_description(e.get("DESCRIPTION", ""))
            merged[uid] = {
                "id": uid,
                "start": start.isoformat(),
                "end": end.isoformat(),
                "code": code,
                "title": title,
                "type": kind,
                "room": e.get("LOCATION", "").strip(),
                "groups": groups,
                "tracks": [track],
            }
            if exam:
                merged[uid]["exam"] = True
                if exam[1]:
                    merged[uid]["tbc"] = True
    # les examens n'ont pas de code dans ADE : on retrouve la matière par son nom (couleur et devoirs associés)
    subjects = {}
    for ev in merged.values():
        if ev["code"] and not ev.get("exam") and ev["code"] not in subjects:
            subjects[ev["code"]] = ev["title"]
    for ev in merged.values():
        if ev.get("exam") and not ev["code"]:
            ev["code"] = match_subject(ev["title"], subjects)
            if ev["code"]:
                ev["title"] = subjects[ev["code"]]
    out = sorted(merged.values(), key=lambda x: (x["start"], x["title"]))
    for ev in out:
        ev["tracks"].sort()
    return {"updated": now.isoformat(timespec="minutes"), "tracks": sorted(feeds), "events": out}


def fetch_homework() -> dict | None:
    """Copie publique des devoirs et modifs depuis le script Google (la même que celle lue par le site).
    L'adresse est lue directement dans index.html : rien à configurer en plus."""
    m = re.search(r'const HW_API = "(https://script\.google\.com/[^"]+)"', (ROOT / "index.html").read_text(encoding="utf-8"))
    if not m:
        return None
    try:
        data = json.loads(fetch(m.group(1)))
        return data if isinstance(data.get("items"), list) else None
    except Exception as err:  # Google indisponible : on garde l'ancienne copie, ADE est quand même mis à jour
        print(f"Devoirs non récupérés ({err}), ancienne copie conservée.")
        return None


def main() -> None:
    feeds: dict[str, str] = {}
    if len(sys.argv) > 1:
        for arg in sys.argv[1:]:
            track, _, path = arg.partition("=")
            feeds[track.upper()] = Path(path).read_text(encoding="utf-8")
    else:
        for track in ("FISE", "FISA"):
            url = os.environ.get(f"ADE_URL_{track}")
            if url:
                feeds[track] = fetch(url)
        if not feeds:
            sys.exit("Aucun lien ADE (ADE_URL_FISE / ADE_URL_FISA)")
    for track, text in feeds.items():
        if "BEGIN:VCALENDAR" not in text:
            sys.exit(f"La réponse d'ADE pour {track} n'est pas un calendrier iCal, events.json n'est pas modifié.")
    data = build(feeds)
    if not data["events"] and OUT.exists():
        sys.exit("Aucun cours reçu, on garde l'ancienne version par sécurité.")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    old = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {}
    hw = fetch_homework() if len(sys.argv) == 1 else None
    data["homework"] = hw if hw is not None else old.get("homework")
    if data["homework"] is None:
        del data["homework"]
    # On ne réécrit le fichier que si les cours, devoirs ou modifs ont changé (pas pour un simple horodatage).
    same_hw = (old.get("homework") or {}).get("items") == (data.get("homework") or {}).get("items") and \
              (old.get("homework") or {}).get("changes") == (data.get("homework") or {}).get("changes")
    if old.get("events") == data["events"] and same_hw:
        print("Aucun changement.")
        return
    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{len(data['events'])} cours écrits dans {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
