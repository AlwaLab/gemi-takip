# Gemi Takip

## 👉 [Haritayı aç: alwalab.github.io/gemi-takip](https://alwalab.github.io/gemi-takip/)

Seçtiğiniz gemilerin konumunu her 30 dakikada bir toplayan ve herhangi bir bilgisayardan
açılabilen bir harita sayfası. Her şey ücretsiz GitHub üzerinde çalışır; bilgisayarınızın açık
olması gerekmez.

## Nasıl çalışır

1. GitHub Actions her 30 dakikada bir `collector/collect.py` betiğini çalıştırır.
2. Betik birkaç dakika boyunca aisstream.io'yu dinler ve `ships.json` içindeki gemilerin
   konumunu alır.
3. Konumlar `docs/data/positions.csv` (tüm geçmiş) ve `docs/data/latest.json` (son durum)
   dosyalarına yazılıp depoya kaydedilir.
4. GitHub Pages, `docs/` klasörünü `https://KULLANICI.github.io/DEPO/` adresinde yayınlar.
   Sayfa haritayı, rotaları ve "Tüm konumları indir (CSV)" düğmesini gösterir.

## Gemi ekleme / çıkarma

GitHub'da `ships.json` dosyasını düzenleyin (sayfadaki *Gemi ekle / çıkar* bağlantısı doğrudan
oraya götürür):

```json
{
  "ships": [
    {"mmsi": "271000835", "label": "Bizim tanker"},
    {"mmsi": "240894000", "label": ""}
  ]
}
```

Kaydettiğinizde toplama hemen bir kez çalışır, sonra her 30 dakikada bir devam eder.
MMSI numarasını bilmiyorsanız MarineTraffic veya VesselFinder'da gemi adını aratın.

## Kurulum (bir kerelik)

- **GitHub deposu:** herkese açık (public) olmalı. Hem Pages hem sınırsız Actions süresi ücretsiz
  planda yalnızca açık depolarda var.
- **Gizli anahtar:** depo → *Settings* → *Secrets and variables* → *Actions* →
  `AISSTREAM_API_KEY` adıyla aisstream.io anahtarı.
- **Pages:** depo → *Settings* → *Pages* → *Deploy from a branch* → `main` / `/docs`.
- **Elle çalıştırma:** depo → *Actions* → *Konum topla* → *Run workflow*.

## Bilinmesi gerekenler

- **Kapsam:** aisstream.io çoğunlukla kıyıdaki alıcılardan beslenir. Açık denizdeki bir gemiden
  o turda konum gelmeyebilir; sayfada "x saat önce" olarak görünür.
- **Zamanlama:** GitHub zamanlanmış görevleri birkaç dakika (bazen 15+) geciktirebilir.
- **Gizlilik:** Depo ve sayfa herkese açıktır; hangi gemileri izlediğiniz görülebilir.
  API anahtarı gizli kalır.
- **Sınır:** Bir aisstream.io aboneliğinde en fazla 200 MMSI.

## Yerel uygulama (isteğe bağlı)

Bu bilgisayarda canlı (saniyelik) takip için eski uygulama da duruyor: `start.bat` →
<http://localhost:8765>. Anahtar `data/config.json` dosyasındadır ve git'e gönderilmez.

## Dosyalar

```
ships.json                    takip edilen gemiler
collector/collect.py          30 dakikalık toplama turu
.github/workflows/collect.yml GitHub zamanlayıcısı
docs/                         yayınlanan harita sayfası ve veriler
server/, static/, start.bat   yerel canlı uygulama
```
