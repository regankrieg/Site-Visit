# Site Notes

A field / site visit notes app for architecture/engineering work — build a report with a
title, project #, summary of observations, attendees and numbered notes, and attach photos
to specific notes. Same look and file layout as OpsBoard. Runs entirely in the browser, so it
works on an iPad in Safari. Nothing to install and no server needed.

## How it differs from OpsBoard

OpsBoard saves to `data.json` through a PowerShell server (`server.ps1`), which can't run on an
iPad. Site Notes has no server: reports and photos are saved in the browser's own storage
(IndexedDB) on the device you use it on.

- `index.html` — page shell and sidebar
- `style.css` — OpsBoard theme + photo / export / touch / print styles
- `app.js` — everything else (storage, report editor, photos, export, backup)

## Getting it on the iPad

The four files must stay together in one folder.

1. **Hosted (recommended):** put the folder on any static host (GitHub Pages, Netlify, etc.), open
   the address in Safari, then Share → **Add to Home Screen**. It opens full screen like an app,
   and Home Screen apps are the least likely to have their storage cleared.
2. **Local only:** keep the folder in Files / iCloud Drive and open `index.html` with an app that
   previews HTML with JavaScript (Textastic, Koder, etc.). Safari itself can't open local files from Files reliably.

Your reports stay on the device — hosting only serves the app's code, not your data.

## Using it

- **Reports** → **+ New Report**. Title, project #, date, location, summary, attendees.
- **Field Notes** → **+ Add Note**. Notes number themselves 1, 2, 3…; **+ Add Sub-note** adds 1.1, 1.2…
  under a note. ↑ / ↓ reorder and the numbering follows.
- **Take Photo** opens the camera; **From Library** picks existing photos. Photos attach to that
  specific note or sub-note, can be captioned, and are shrunk to 1600 px to save space.
- Everything saves automatically (the dot in the sidebar turns amber while a change is pending).

## Screen sizes

`app.js` measures the window (and re-checks on resize or rotation) and switches the layout:

- **Phone** (under 600px): slim top bar, single column, notes with controls underneath, 2-column photos,
  floating **+ Note** button, bottom-sheet dialogs. A phone held sideways still counts as a phone.
- **Tablet portrait** (600-899px): top bar, roomier single column.
- **Laptop / iPad landscape** (900-1199px): narrow sidebar.
- **Desktop** (1200px+): full sidebar.

To change where the switches happen, edit `LAYOUT_BREAKPOINTS` at the top of `app.js`.

## Exporting a report

**Export Report** (top right of a report) produces a folder named
`ProjectNo_Title_Date` containing:

- `ProjectNo_Title_Date.txt` — report info, summary, attendees and the numbered notes, with each
  note's photos listed by file name and caption
- `Photo_01_Note_1.jpg`, `Photo_02_Note_2-1.jpg`, … — every photo, named for the note it belongs to

On an iPad it downloads as a `.zip` (or use **Share…** → Save to Files); tapping the zip in Files
unfolds it into that folder. On desktop Chrome/Edge, **Save to Folder…** writes the real folder directly.
**Print / PDF** gives a formatted printout with the photos under each note.

## Backup

**Backup & Restore** saves all reports and photos to a single `.json` file you can keep in Files /
iCloud Drive, and loads it back on any device. Do this regularly — browser storage can be cleared
by the OS if the device runs low on space or the site isn't used for a long time.
