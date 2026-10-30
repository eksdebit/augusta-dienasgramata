# Cukuriņa pieraksti

Diabēta dienasgrāmata telefonam (PWA): insulīns, ēdienreizes ar MV, glikoze, Dexcom Clarity imports, izdrukas, ģimenes piekļuve.

- Frontends: statiski faili (`index.html`, `app.js`, `app.css`), publicēti ar GitHub Pages.
- Dati: Supabase projekts "Augusta dienasgramata" ar rindu līmeņa drošību (RLS) — katrs redz tikai tās dienasgrāmatas, kurās ir dalībnieks.
- Atpazīšana: Supabase Edge Function `parse` (`supabase/functions/parse`) izsauc Claude API ar atslēgu, kas glabājas tikai Supabase secrets.

`config.js` satur publisko (publishable) atslēgu — tā ir paredzēta pārlūkam; slepenu atslēgu šajā repozitorijā nav.
