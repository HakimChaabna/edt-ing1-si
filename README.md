# EDT ING1 SI

Page web de l'emploi du temps de la classe ING1 SI (EPISEN), synchronisée automatiquement avec ADE.

- `index.html` : la page (vue jour sur téléphone, vue semaine sur ordinateur)
- `scripts/build.py` : récupère l'export iCal d'ADE et produit `data/events.json`
- `.github/workflows/update.yml` : lance le script toutes les 30 min (6h–23h)

Les liens ADE sont stockés dans les secrets GitHub `ADE_URL_FISE` et `ADE_URL_FISA`, ils n'apparaissent pas dans le code.

Tester en local :

    ADE_URL_FISE="https://..." ADE_URL_FISA="https://..." python3 scripts/build.py
    python3 -m http.server   # puis ouvrir http://localhost:8000
