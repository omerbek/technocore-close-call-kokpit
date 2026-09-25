# Close Call Kokpit

FLOP Labs'in **Technocore Close Call (close-1)** NVDA tahmin yarışması için tarayıcıda imzalayan, bağımlılıksız işlem masası.

- `technocore-did-starter` ile oluşturduğun **şifreli `identity.pem` dosyasını doğrudan** yükler. JSON'a çevirmen gerekmez, JWK `.json` da çalışır.
- Birden çok DID'i aynı anda yükleyip aralarında geçiş yapabilirsin. İki DID'in arasında tek tıkla işlem de açabilirsin.
- Hakem odalarının sahipliğini, imzalı launch seed'ini ve seed'in sabitlediği resmî paket SHA-256 değerini doğrular. Referans fiyatı, limitleri, sweep sayacını ve canlı sıralamayı gösterir.
- `npm install` gerekmez: sadece Node.js 20+.

> Resmi kurallar: [flop-labs/technocore-close-call-challenge](https://github.com/flop-labs/technocore-close-call-challenge). Bu araç topluluk yapımıdır, FLOP Labs'e ait değildir ve ödül vaadi içermez.

## Çalıştırma

### GitHub Codespaces (kurulum yok)
1. Bu repoda **Code → Codespaces → Create codespace** de.
2. Terminal açılınca `npm start` yaz.
3. Sağ alttaki **Open in Browser** bildirimine tıkla (ya da **Ports** sekmesinden 5300'ü aç).

### Kendi bilgisayarında
```bash
git clone https://github.com/omerbek/technocore-close-call-kokpit
cd technocore-close-call-kokpit
npm start
```
Sonra tarayıcıda `http://localhost:5300` adresini aç.

## Kullanım

1. **DID yükle:** Sol panelden `identity.pem` dosyanı seç, parolanı yaz, **DID yükle**'ye bas.
2. **Kayıt ol:** DID kartındaki **Kayıt ol** butonu. Bir sonraki sweep'te (≤5 dk) 10.000 POLF gelir. Her DID bir kez kayıt olur. Daha önce kayıt olduysan yeni kayıt gönderme; **Daha önce kaydoldum** ile bu tarayıcıda onayla.
3. **Tahmin yap:** LONG (yükselir) veya SHORT (düşer) seç, fiyat, miktar ve süreyi gir, **İmzala ve yayınla**'ya bas. Teklif biri kabul edene kadar pozisyon açmaz.
4. **Açık tahminler:** Başkalarının tekliflerini gör, **Kabul et** ile karşı yönde pozisyon al.
5. **İşlemlerim:** Durum hakemin `d-close1-flow` odasından okunur: *Bekliyor*, *Sonuçlandı*, *Geçersiz: sebep*. Görülen nihai sonuçlar bu tarayıcıda saklanır; özel anahtar saklanmaz.
6. **Sıralama:** Hakemin yayınladığı canlı PnL tablosu. Kendi DID'lerin vurgulanır.

İki DID yüklediysen, **Karşı taraf** menüsünden diğer DID'ini seç. İşlem iki imzayla birlikte doğrudan `close1`'e gönderilir.

Kokpit, imzalı seed/paket ve hakem odaları doğrulanmadan ya da aktif DID kayıtlı görünmeden kayıt dışındaki imzalı işlemleri açmaz. Referee'nin eski mint listeleri kısaltılabildiği için daha önce kayıtlı bir DID'de **Daha önce kaydoldum** onayı gerekebilir; bu onay yalnızca arayüz kilidini açar, hakemin kararını değiştirmez.

## Kurallardan önemli notlar

- Fiyat, hakemin son referansının **±%5**'i içinde olmalı, yoksa işlem `limits` ile geçersiz olur.
- Her işlemde iki taraf da **%1 ücret** öder. Hyperliquid fiyatından daha iyi fiyat alan taraf farkı geri öder. Gereksiz al-sat skoru düşürür.
- Kaldıraç yok: her kontrat fiyatı kadar POLF bağlar (10.000 POLF ≈ 44 kontrat).
- İşlemler **4 Ekim 2026 09:00 UTC**'de kilitlenir. Kapanış fiyatı, 10:00 UTC'den önceki son Hyperliquid `xyz:NVDA` işlemidir. Skor = son bakiye − 10.000. İlk üç, 1.000.000 FLOP'u paylaşır.

## Güvenlik

- Özel anahtar sadece açık tarayıcı sekmesinde kalır. PEM, WebCrypto ile (PBKDF2 + AES-CBC) tarayıcıda çözülür ve **dışa aktarılamayan** bir imza anahtarı olarak tutulur. Sayfa yenilenince unutulur.
- Sunucuya sadece imzalı mesaj gider. Sunucu imzayı doğrular ve yalnızca `close1` ile `close1-offers` odalarına iletir. Başka bir yere bağlanmaz (CSP ile de engellenir).
- Yazma işlemleri ancak sabit hakem DID'i, beş hakem odasının sahipliği, imzalı launch seed'i, resmî paket hash'i ve canlı fiyat yayını birlikte doğrulandığında açılır.
- Kod kısa ve bağımlılıksız: [`public/keys.js`](public/keys.js) anahtar yükleme, [`server.js`](server.js) sunucu. Kullanmadan önce okuyabilirsin.
- Yayınlanmış bir teklif geri çekilemez. Kısa süre seç.
- Sadece bu yarışma için kullandığın DID'leri yükle.

## Test

```bash
npm test
```
Testler, starter'ın kendi yöntemiyle oluşturulmuş boş bir anahtarla (`test/fixtures`) PEM çözmeyi, imzaları ve sunucu kontrollerini doğrular.

---

**English:** A zero-dependency, browser-signing desk for the Technocore Close Call (close-1) contest. Load the starter's encrypted `identity.pem` directly, register, publish LONG/SHORT offers, accept open offers, and follow your trades. Keys never leave the tab. Run `npm start` in a Codespace or locally and open port 5300.

MIT License.
