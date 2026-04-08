# Překladač ebooků

První pracovní verze EPUB překladače pro dlouhý text s důrazem na:

- rozpoznání `front matter`, `main matter` a `back matter`
- vyřazení obsahu, rejstříku, pramenů, poznámek a podobného balastu před překladem
- provider strategii pro `DeepL`, `OpenAI`, `Google Cloud Translation` a volitelně `Claude`
- review mód, kde jde každou sekci ručně zahrnout nebo vyřadit

Design frontendové vrstvy přebírá vizuální jazyk z lokální aplikace `adam 2/web`.

## Co už umí

- nahrát EPUB do lokálního backendu
- rozbalit EPUB a projít `spine`
- analyzovat XHTML sekce
- heuristicky určit hlavní text knihy
- navrhnout začátek a konec hlavního textu
- ořezat konce sekcí, když se na závěru kapitoly objeví poznámky, reference nebo bibliografie
- nabídnout provider matrix podle typu překladu
- vygenerovat krátký překladový preview blok z prvních zahrnutých sekcí
- složit nový čistý EPUB jen z vybraných sekcí
- ukládat persistentní překladovou cache po blocích textu, aby export šel obnovit bez opakovaného překladu
- spouštět export jako persistentní background job s progress trackingem
- po restartu serveru znovu zařadit `queued` a `processing` joby

## Co je další krok

- glossary workflow a chapter cache
- jemnější klasifikace inline poznámek uvnitř samotných odstavců
- volitelný paralelní překlad po kapitolách s omezením rate limitů providerů

## Spuštění

```bash
npm install
npm install --workspace backend
npm install --workspace frontend
cp .env.example .env
npm run dev:backend
```

V druhém terminálu:

```bash
npm run dev:frontend
```

Frontend běží na `http://localhost:5173`.
Backend běží na `http://localhost:4317`.

## Proměnné prostředí

Viz [.env.example](/Volumes/CODEX_DISK/apps/překladač%20ebook/.env.example).

Pro první použitelnou variantu stačí:

- `DEEPL_API_KEY`

Volitelně:

- `OPENAI_API_KEY`
- `GOOGLE_CLOUD_PROJECT`
- `GOOGLE_CLOUD_ACCESS_TOKEN`
- `ANTHROPIC_API_KEY`

## Poznámka k providerům

- `DeepL` je nastavený jako default.
- `OpenAI GPT-5.4` je zamýšlený jako precision fallback.
- `Google Cloud Translation Advanced` je připravený pro terminology mode.
- `Claude` je zatím doplňkový fallback.
