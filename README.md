# CountryDropdownPCF

A searchable country picker for a **Single Line of Text** column on a Dynamics 365 / Power Apps model-driven form.
Countries are read at runtime from a configurable Dataverse table through `context.webAPI`; the chosen country
**name** is written to the bound text column and persisted by the **normal form Save**.

- Virtual (React) PCF control using the platform's React 16.14 and Fluent UI v9.46 — the shipped bundle is ~13 KB.
- No hard-coded country list, no external network calls, no `localStorage`, no `updateRecord`.

---

## 1. Architecture

```
CountryDropdownPCF/
├── CountryDropdownPCF.pcfproj          MSBuild project (used by `pac solution add-reference`)
├── package.json / tsconfig.json / pcfconfig.json / eslint.config.mjs
├── scripts/Build-Solution.ps1          One-shot build + solution packaging
├── .github/workflows/build-solution.yml  CI: builds managed + unmanaged solution zips
└── CountryDropdownPCF/
    ├── ControlManifest.Input.xml       Bound + input properties, platform libraries, WebAPI feature
    ├── index.ts                        PCF lifecycle (init / updateView / getOutputs / destroy)
    ├── components/CountryDropdown.tsx  Fluent v9 Combobox UI, filtering, states
    ├── hooks/useCountries.ts           Load-once-per-config, ignores obsolete responses
    ├── services/CountryService.ts      OData query, pagination, retry, dedupe, error mapping
    ├── css/CountryDropdownPCF.css
    └── strings/CountryDropdownPCF.1033.resx
```

**Data flow**

1. `updateView()` reads the bound value and the configuration properties and renders `<CountryDropdown>`.
2. `useCountries` loads the list once per configuration key. Re-renders never refetch; a module-level cache also
   de-duplicates requests when the control appears more than once on a form. Late responses after a config change
   or unmount are ignored.
3. `CountryService` calls `retrieveMultipleRecords(table, "?$select=…&$filter=… ne null[ and statecode eq 0]&$orderby=…", 5000)`,
   follows `nextLink` (up to 20 pages / 100k rows), retries throttling/network failures with back-off, trims and
   removes case-insensitive duplicate names, and sorts by name.
4. Selecting a country → `notifyOutputChanged()` → `getOutputs()` returns `{ countryValue: name }` → the form
   attribute is dirty → the user's Save persists it. Clearing returns `undefined`, which saves `null`.

**Value reconciliation (`index.ts`)** — after a selection the control shows its pending value until the platform
echoes it back. If the platform reports a *different* bound value (form refresh, discard changes, business rule,
`setValue` from script) the external value wins.

**Search** — case- and accent-insensitive (`cote` finds `Côte d'Ivoire`), matches the optional code column too
(`pk` → Pakistan), "starts with" matches rank above "contains". Free text is never saved: closing the list without a
selection restores the saved value.

### Platform limitations to know

| Topic | Detail |
|---|---|
| Configuration values | PCF input properties are **static per form placement**, set in the form designer. Changing the table/column requires editing the form and republishing. |
| Logical names | Must be lowercase *logical* names (`new_country`), not display names. They are validated (`^[a-z][a-z0-9_]*$`) before being placed in OData. |
| Active filter | "Active records only = Yes" adds `statecode eq 0`. Set it to **No** for tables without `statecode` (e.g. some virtual tables). |
| Test harness | `npm start` does **not** implement `context.webAPI`, so the harness shows the error state. Test data loading in a real environment (`pac pcf push`). |
| Field length | If a country name exceeds the column's MaxLength it is shown disabled in the list rather than failing on save. |
| Values not in table | Existing text that isn't in the table (legacy data) is still displayed, with a warning. |
| Security | All reads run as the signed-in user. Users need **Read** on the country table; field-level security on the bound column is honoured (masked / read-only). |
| React/Fluent | Requires an environment that supports virtual (React) code components with platform libraries — current online environments do. |

---

## 2. Manifest properties

| Property | Usage | Type | Required | Example | Meaning |
|---|---|---|---|---|---|
| `countryValue` | **bound** | SingleLine.Text | yes | your `new_country` text column | Receives the selected country name |
| `countryTableName` | input | SingleLine.Text | yes | `new_country` | Logical name of the country table |
| `countryNameColumn` | input | SingleLine.Text | yes | `new_name` | Logical name of the display-name column |
| `countryCodeColumn` | input | SingleLine.Text | no | `new_code` | Optional code column, shown + searchable |
| `activeRecordsOnly` | input | Enum (Yes/No) | no (Yes) | Yes | Filter `statecode eq 0` |

To change defaults for your environment, edit the `default-value` attributes in `ControlManifest.Input.xml`.

### Example country table

Create (or reuse) a custom table, e.g. display name **Country**, logical name `new_country`, primary column
`new_name`, plus optional text column `new_code`. Load data with *Import from Excel/CSV* or a dataflow. Grant
**Read** (Organization level, typically) on it to the security roles that use the form.

---

## 3. Build & deploy (Windows PowerShell)

### 3.1 Prerequisites

```powershell
# Node.js LTS (18+). Verify:
winget install OpenJS.NodeJS.LTS
node -v; npm -v

# .NET SDK (for building the solution project)
winget install Microsoft.DotNet.SDK.8
dotnet --version

# Power Platform CLI (pac)
dotnet tool install --global Microsoft.PowerApps.CLI.Tool
# or update an existing install:
dotnet tool update --global Microsoft.PowerApps.CLI.Tool
pac help
```

> Alternatively install the **Power Platform Tools** VS Code extension, which bundles `pac`.

### 3.2 Project

This repository already is the PCF project (equivalent to
`pac pcf init --namespace TalhaPCF --name CountryDropdownPCF --template field --framework react --run-npm-install`).
Unzip it, then:

```powershell
cd C:\src\CountryDropdownPCF
npm install
npm run build          # dev build + lint + manifest validation
npm run build:prod     # minified build used for deployment
```

### 3.3 Test harness (UI only)

```powershell
npm start watch
```

Opens `http://localhost:8181`. Because the harness has no Web API, you will see the "Countries could not be
loaded" state — expected. Use it for layout/keyboard checks only.

### 3.4 Fast dev deployment (optional)

```powershell
pac auth create --environment https://yourorg.crm.dynamics.com
pac pcf push --publisher-prefix tal
```

`pac pcf push` imports into a temporary `PowerAppsTools_tal` solution — good for iteration, not for ALM.

### 3.5 Package into a solution

**Automated (recommended):** every push to `main` runs `.github/workflows/build-solution.yml` on GitHub Actions and
uploads `CountrySelector_managed.zip` and `CountrySelector.zip` as the run's artifact
(*Actions → Build PCF solution → latest run → Artifacts*). Publishing a GitHub Release (or pushing a `v*` tag) also
attaches both zips to that release.

**Locally:**

```powershell
.\scripts\Build-Solution.ps1 -PublisherName "TalhaManzoor" -PublisherDisplayName "Talha Manzoor" -PublisherPrefix "tal" -PackageType Both
```

What it runs:

```powershell
npm ci
npm run build:prod
mkdir Solution\CountrySelector; cd Solution\CountrySelector
pac solution init --publisher-name TalhaManzoor --publisher-prefix tal
# then set the publisher display name to "Talha Manzoor" in src\Other\Solution.xml (the script does this)
pac solution add-reference --path ..\..
dotnet build --configuration Release      # SolutionPackageType = Both
# -> Solution\CountrySelector\bin\Release\CountrySelector.zip and CountrySelector_managed.zip
```

Use the **same publisher prefix** as the solution you'll deploy alongside, or you'll end up with two publishers.

### 3.6 Import

```powershell
pac auth create --environment https://yourorg.crm.dynamics.com
pac solution import --path .\CountrySelector_managed.zip --publish-changes
```

(Or *make.powerapps.com → Solutions → Import solution*. Use the managed zip for test/production, the unmanaged one only in your dev environment.)

### 3.7 Add the control to the field

1. make.powerapps.com → **Tables** → your table → **Forms** → open the main form.
2. Select the existing **Single Line of Text** country field on the canvas.
3. In the right pane: **Components → + Component → Searchable Country Dropdown** (if it isn't listed, click
   **Get more components**, find it, **Add**).
4. Set the properties (choose **Static value**):
   - Country table logical name: `new_country`
   - Country name column logical name: `new_name`
   - Country code column logical name: `new_code` (or leave empty)
   - Active records only: Yes
5. Tick **Web**, **Mobile**, **Tablet** as needed → **Done**.
6. **Save and publish** the form.

Classic designer equivalent: *Field Properties → Controls → Add Control… → Searchable Country Dropdown*, select the
Web/Phone/Tablet radio buttons and edit each property's value.

### 3.8 Test

Open a record (hard-refresh with Ctrl+F5 after publishing), pick a country, Save, reopen. Then run the checklist below.

---

## 4. Testing checklist

| # | Scenario | Steps | Expected |
|---|---|---|---|
| 1 | Load success | Open a record | Brief "Loading countries…", then dropdown enabled |
| 2 | Search | Type `pak` | Pakistan listed; typing `PAK` gives same result |
| 3 | Accent / code search | Type `cote`; type `pk` (with code column) | Côte d'Ivoire; Pakistan ranked first |
| 4 | Select | Click or Arrow + Enter | Name in field, form shows unsaved changes |
| 5 | Save | Ctrl+S | Column stores the exact display name (check in Advanced Find/grid) |
| 6 | Reopen | Close and reopen record | Saved country displayed |
| 7 | Edit existing | Change to another country, Save | New value persisted |
| 8 | Discard | Change value, then Refresh and choose discard | Original value returns |
| 9 | No match | Type `zzz` | "No countries match “zzz”" (not selectable) |
| 10 | Empty table | Deactivate/delete all rows | Warning "No countries are available…", control disabled, existing value still visible |
| 11 | Bad table name | Set table to `new_countri` | Error "configured country table was not found" |
| 12 | Bad name column | Set column to `new_nme` | Error "configured column was not found" |
| 13 | Invalid syntax | Set table to `Country Table` | Config error naming the invalid logical name, no request sent |
| 14 | Permissions | Remove Read on the country table from the user's role | "You don't have permission…" + Retry |
| 15 | Throttling / network | DevTools → Network → Offline, reload; or simulate 429 | Retries with back-off, then error + Retry button; Retry works once online |
| 16 | Large table | Import > 5,000 rows | All rows load via paging; list shows first 300 matches with "keep typing" hint |
| 17 | Duplicates | Two rows named `Germany` / `germany ` | Single entry |
| 18 | Clear | Click the ✕ in the field, Save | Column saved as empty (null) |
| 19 | Re-render | Change other fields, run business rules | No extra Country requests in DevTools Network tab; value preserved |
| 20 | Script change | `Xrm.Page.getAttribute("new_country").setValue("France")` in console | Control shows France |
| 21 | Read-only / FLS | Make field read-only or secure the column | Disabled; masked as ******** when not readable |
| 22 | Keyboard | Tab in, Alt+Down/typing to open, Arrows, Enter, Escape, Tab out | Full operation without mouse; Escape restores saved value |
| 23 | Screen reader | Narrator/NVDA | Field label announced, option count/position announced |
| 24 | Narrow column | Place in a 1/3-width section, mobile app | No overflow; long names ellipsised |
| 25 | Over-long name | Column MaxLength 10, country "United Kingdom" | Option disabled with tooltip explaining limit |

---

## 5. Customising

- **Defaults:** `default-value` attributes in `ControlManifest.Input.xml`.
- **Max rendered options:** `MAX_VISIBLE_OPTIONS` in `components/CountryDropdown.tsx`.
- **Paging cap / retries:** `MAX_PAGES`, `MAX_RETRIES` in `services/CountryService.ts`.
- **Bump version** in the manifest (`version="1.0.1"`) before re-importing so the platform picks up the new bundle.
