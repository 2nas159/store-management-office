# Product research round 1 — candidates, 26 Oct 2026

Method: the GTM plan (Drive: "AI-Destekli-GTM-Stratejisi", Faz 0–1) and the scoring columns of "Yüksek Potansiyelli Ürünler". All data read in Chrome on 26 Oct 2026. Prices in TRY as listed, before coupons. No number below is guessed; anything unknown says so.

## How candidates were found
1. Meta Ad Library, Türkiye, active ads containing "kapıda ödeme" (~34,000 ads), split by category (mutfak ~500, araç ~670, kedi ~210, köpek ~3,100, temizlik ~1,300, düzenleyici ~95, çocuk ~2,900). Kept ads running 60+ days (started before 27 Aug 2026): an ad that runs that long is paying for itself.
2. Dropped: electrical, liquids, health claims, supplements, jewellery, clothing (sizes), baby items, furniture (bulk), car-model-specific items.
3. Each survivor checked on Trendyol (most-rated sort), Hepsiburada, the Ad Library (advertiser count) and Google Trends (TR, 12 months).

## Shortlist

| | Miniature construction kit | Book nook DIY kit | Grooved "magic" copybook |
|---|---|---|---|
| Trendyol top listing | 926.07 TL · 4.3 (696) | 2,247 TL · 4.4 (346) | 489.02 TL · 4.6 (1,755) |
| Trendyol listings | 1,032 (search is broad) | 207 | 57 |
| Hepsiburada | 14 listings, max 8 reviews | 64 listings, avg 3,094 TL | not checked |
| Meta ads (TR, active) | ~7 ads, 2 real sellers; oldest 492 days | ~0 real (61 hits are a "DramaNook" app) | ~27 ads, 4 sellers, 90–123 days |
| Google Trends | near zero; small October uptick | **rising**: 30 → 85 → 78 last 3 weeks; breakouts "rolife", "book nook nedir" | near zero |
| 3x margin needs cost under | 309 TL | 749 TL | 163 TL |
| Source | made in Turkey | imported (China) | printed in Turkey |
| Compliance | non-electric, fragile clay | **battery LED inside** — conflicts with "no electrical" | ink refills (small liquid), children's product |

### 1. Miniature construction kit (minyatür inşaat seti) — strongest proof
- Leader: Minyatür Hane, https://www.trendyol.com/minyatur-hane/minyatur-insaat-seti-1000-tugla-250-kremit-500-parke-tasi-meral-spatula-harc-p-323950318 — the same company runs the 16-month "Mini nalbur" ad (minyaturhanem.com). The maker is also the market leader: buying from them makes them a competitor.
- 350 reviews read, 78 at 1–3 stars. Themes: broken bricks 20 · missing pieces 20 · wet/damp on arrival 11 · mortar missing or not holding 10 · cargo 8 · quality 8 · price 6. Trendyol's own summary agrees (missing/broken parts).
- Angle: packed so nothing breaks or gets damp, counted complete kits, mortar that works with a Turkish video guide, project plans.

### 2. Book nook DIY kit — best timing and order value
- Leader: Emirgan (Owl Bookstore 346 reviews, Seyahat İzleri 88, Atatürk Çalışma Odası 44, Balon Ev 22), all ~2,250–2,330 TL. A Turkish-themed design already sells.
- 207 reviews read, 37 at 1–3 stars. Themes: hard assembly / parts don't fit 16 · quality 8 · glue 5 · broken 3 · manual pictures missing. Trendyol summary: quality materials, "therapy" feel, delicate parts.
- Angle: Turkish designs, a Turkish video build guide, pre-checked fit.
- Open: the LED (owner decision on the electrical rule); bulk import cost and duty.

### 3. Grooved copybook — demoted
- Real demand and working ads, but at least 4 Turkish publishers hold 300–1,757 reviews each at 298–489 TL, and the DTC advertiser (Minolio) also sells on Trendyol at 850 TL (384). Hard to beat publishers on price.

## Rejected this round
Snuffle mat (see [[2026-10-26-snuffle-mat]]) · expandable sink colander (9 reviews) · moving straps (≤24 reviews) · pet products (all ads under 60 days, nothing proven yet) · kitchen best sellers (mostly under 350 TL) · organisers (commodity).

## Rule change that affects every product
Since February 2026 Turkey charges duty on every postal/express parcel from abroad: the €30 exemption was abolished (Cumhurbaşkanı Kararı, Resmi Gazete 6–7 Jan 2026), 60% for non-EU origin, simplified declaration removed. Per-order shipping from China (AliExpress model) no longer works; cost must come from a Turkish supplier or a bulk import under normal rules. Confirm the exact rates for the product's HS code before ordering.
Sources: https://www.hurriyet.com.tr/bilgi/galeri/yurt-disi-gumruk-vergisi-siniri-2026-ne-kadar-oldu-dustu-mu-30-euro-siniri-kalkti-mi-43078592 · https://www.lires.com.tr/post/g%C3%BCmr%C3%BCks%C3%BCz-al%C4%B1%C5%9Fveri%C5%9F-devri-kapand%C4%B1-posta-30-euro-muafiyetinin-kald%C4%B1r%C4%B1lmas%C4%B1-2026-ve-yeni-d%C3%B6nem

## Not done yet (Faz 0 needs real figures)
- Product cost: Alibaba asked for a CAPTCHA (not bypassed). Needs supplier quotes: Turkish wholesale for the construction kit, a bulk import quote for book nooks.
- Domestic shipping per parcel (by desi), payment and cash-on-delivery fees, return rate: need the owner's cargo and payment contracts.
- Then: break-even ROAS = price / (price − variable cost), max CPA, at 10/20/30% returns.
- Amazon.com.tr: blocked by the Chrome extension's site permissions on this machine.
- Raw 1–3 star review lines were read and themed, not stored; re-pull from the review pages above for Faz 2.

## Method notes for agents
- Trendyol review pages: `<product-url>/yorumlar`, scroll to load; stars = 5 − round(padding-inline-end of `.star-rating-full-star` ÷ (its width ÷ 5)).
- Ad Library: wait ~4 s and scroll; cards come after the count. Keyword "kapıda ödeme" + category word finds Turkish DTC stores.
- Output over ~1,000 characters from the page is cut off; keep rows short.
