# FlowMap 1.5.0

Bu sürüm kayıtlı likidite geçmişini incelemeyi, işlem akışı çalışma alanını ve
desteklenen halka açık L2 kaynaklarının entegrasyonunu geliştirir.

- **Kayıtlı derinlik geçmişi:** Canlı belleğin dışındaki gerçek kayıtlar diskten
  yüklenir. Geniş zaman görünümü kayıtlı miktarları birleştirir; yakınlaştırma
  özgün ayrıntıya döner. Fiyat aralığı değişiklikleri fiziksel fiyatları korur,
  kayıtsız aralıklar boş görünür. İlk büyük geçmiş yüklemesi ilerlemeli disk
  okumasıdır; hazır olma süresi kayıt boyutuna ve bilgisayara bağlıdır.
- **Çalışma alanı:** Orderflow, Analysis ve Focus düzenleri, boyutlandırılabilen
  DOM/tape/CVD panelleri, son seçilen enstrümanın hatırlanması ve
  15s/1m/5m/30m/All zaman aralığı düğmeleri eklendi.
- **Gerçek veri göstergeleri:** Alış/satış fiyatları ve içerideki miktarlar,
  spread ve son alınan kotasyonun yaşı gösterilir. İşlem akışı paneli alınan
  işlemlerden 5/30/60 saniyelik alış, satış ve delta miktarlarını hesaplar;
  eksik işlem yönü veya derinlik kullanılabilir veri gibi sunulmaz.
- **Grafik ve likidite:** Tolerans ve normalizasyon görünür likiditeye göre
  ayarlanır. Geçmiş görünümü, fiyat ekseni ve grafik katmanlarının koordinatları
  birlikte çalışır; DOM gruplaması ile kotasyon/tape fiyat hassasiyeti ayrılır.
- **Ücretsiz L2 entegrasyonu:** Vendored Crocodile motoru desteklenen halka açık
  bağlantılarla kullanılır. Kaynağın gerçek derinlik modu ve kitap güncelleme
  sayaçları iletilir; veri sıklığı borsa ve seçilen bağlantıya bağlıdır.
- **Intelligence panelleri:** Daha önce yayımlanmamış `9d3d281` kaynak
  değişikliğindeki FLOW, GOV, DOCS, GEO ve MACRO görünümleri bu sürüme dahildir.
  Demo içerik SIM-DEMO ile sınırlandırılır. Kaynak veri sağlamadığında örnek
  rakam veya olay üretilmez. GEX bir model olarak etiketlenir; gamma flip
  yalnızca gerçek işaret geçişi bulunursa hesaplanır. Metinden ses ölçümü
  çıkarılmaz, risk bölümü olmayan SEC metni risk uyarısına dönüştürülmez.
- **İncelemede bulunan hatalar:** Enstrüman değişiminde eski profil temizlenir.
  Yavaş ekranda çizilmiş grafik yükleniyor ekranının altında kalmaz. Gösterge
  seçici `I`, araştırma paneli `J` ile açılır. İşlem eşikleri kaynak miktarını
  kullanır; farklı kontrat birimleri USD olarak gösterilmez.
- **Masaüstü paketleme:** Windows sunucu işlemi konsol penceresi açmadan çalışır
  ve uygulama kapandığında sonlanır. Uygulama, istemci ve sunucu sürümleri
  1.5.0 olarak eşitlendi; paketleme kilitli bağımlılıkları ve vendored motoru
  kullanır.

Yayın iş akışı macOS Apple Silicon/Intel DMG, Windows x64/ARM64 MSI ve NSIS,
Linux x64 DEB paketlerini üretir. Linux AppImage ek paket olarak denenir;
zorunlu paket değildir. SHA256SUMS dosyası ve derleme kaynağı attestation
kayıtları yayın varlıklarıyla birlikte sunulur.
