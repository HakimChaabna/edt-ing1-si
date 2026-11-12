# Planning ING1 SI

Emploi du temps de la promo ING1 Systèmes d'information de l'EPISEN, synchronisé avec ADE, avec les devoirs et les infos de cours partagés par la classe.

**[Ouvrir le planning](https://hakimchaabna.github.io/edt-ing1-si/)**

## Fonctionnalités

- **Emploi du temps à jour** : récupéré automatiquement depuis ADE (l'outil d'emploi du temps de l'université) toutes les 30 minutes.
- **FISE et FISA** : un sélecteur affiche le parcours de chacun, avec les cours communs fusionnés.
- **Lisible sur téléphone** : vue semaine sur ordinateur, défilement jour par jour sur mobile, ajout possible à l'écran d'accueil comme une appli.
- **Devoirs et interros** : chaque élève peut proposer un devoir de façon anonyme. La proposition apparaît en grisé, sans détail, jusqu'à sa validation par un délégué.
- **Mode délégué** : validation des propositions, ajout direct de devoirs, et infos de cours (annulé, en visio, changement de salle, note, cours ajouté).
- **Affichage instantané** : les données sont mises en cache sur le téléphone et copiées par le robot, puis mises à jour en direct.

## Architecture

```
cron-job.org ──► GitHub Actions ──► scripts/build.py ──► data/events.json ──► GitHub Pages ──► navigateur
   (réveil)        (robot)          lit l'export iCal ADE        ▲                                │
                                    nettoie, fusionne FISE/FISA   │ copie des devoirs             │ devoirs, propositions,
                                                                  │                               ▼ mode délégué
                                                            Google Apps Script + Google Sheet (base de données)
```

| Fichier | Rôle |
|---|---|
| `index.html` | La page : affichage, formulaires, mode délégué (HTML, CSS et JavaScript sans framework) |
| `scripts/build.py` | Récupère et nettoie les exports iCal d'ADE (Python, bibliothèque standard uniquement) |
| `.github/workflows/update.yml` | Le robot GitHub Actions |
| `google/Code.gs` | Le script Google Apps Script : API des devoirs et du mode délégué |
| `data/events.json` | Les données générées par le robot |

## Sécurité

- Les liens ADE sont stockés dans les secrets GitHub, jamais dans le code.
- Les codes délégués et les jetons de session ne sont jamais stockés en clair (empreinte SHA-256 salée), avec blocage après plusieurs essais ratés.
- Le texte libre des propositions n'est jamais affiché avant validation, et tout contenu extérieur est échappé avant affichage.
- Le script Google n'a accès qu'à son propre Sheet (`@OnlyCurrentDoc`).

## Comment ce projet a été réalisé

J'ai conçu ce projet en tant que délégué de ma promo, pour répondre à un besoin concret de la classe. Le code a été écrit avec l'aide d'un assistant IA (Claude, d'Anthropic). J'ai défini les besoins et les choix de conception et de design, déployé et configuré l'ensemble des services (GitHub Actions, Google Apps Script, cron-job.org), testé avec les données réelles et fait évoluer le projet à partir des cas rencontrés au quotidien.
