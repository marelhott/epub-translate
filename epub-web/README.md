# epub-web

Oddeleny sandbox pro komercni vrstvu kolem EPUB translatoru.

Tenhle adresar je zamerne mimo aktualni `frontend/` a `backend/`, aby:

- se nerozbil bezici produkcni workbench
- slo navrhovat novy commercial shell bokem
- zustal zachovany kontext aktualnich problemu: packaging, review runtime, infra, auth, pricing

## Co sem patri

- marketingovy web
- pricing stranky
- docs a trust vrstva
- budouci app shell pro komercni flow

## Co sem zatim nepatri

- prepis aktualniho Express backendu
- zasahy do produkcniho deploy flow
- premature monorepo migrace

## Pracovni zasady

1. Faze 0 se dal dela na stavajici kodove bazi.
2. `epub-web/` je priprava na Fazi 2.
3. Nic v tomhle adresari se zatim nema stat blokujici zavislosti pro root projekt.

## Spusteni

Po instalaci zavislosti v tomhle adresari:

```bash
npm install
npm run dev
```

## Aktualni zamer

Prvni iterace bude obsahovat:

- commercial information architecture
- landing shell
- pricing kalkulacku
- app entry shell
- docs / how it works / trust page
