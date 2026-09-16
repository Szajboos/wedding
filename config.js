/* ------------------------------------------------------------------ *
 *  KONFIGURACJA — jedyny plik, który musisz edytować.
 *  Po zmianie: zapisz, wgraj na GitHub Pages, odśwież stronę.
 * ------------------------------------------------------------------ */
window.WESELE_CONFIG = {

  /* Adres wdrożonej aplikacji internetowej Apps Script.
     Wdróż -> Zarządzaj wdrożeniami -> URL aplikacji internetowej (kończy się /exec) */
  apiUrl: 'https://script.google.com/macros/s/AKfycbxVqC6rYomKO-Bt1ojsLJzAeCXcCbzN8AGSV-0h1FanzN-FS1DclFh2VPmKAUOkbyIt/exec',

  /* Nagłówek strony */
  coupleNames: 'Kamila & Filip',
  weddingDate: '19 września 2026',
  welcomeText: 'Zrobiłeś zdjęcie? Wrzuć je tutaj — zobaczą je wszyscy goście.',

  /* Wyłącznik awaryjny: ustaw na false, zapisz i wgraj ten jeden plik,
     żeby natychmiast wyłączyć stronę (bez zmian na GitHub Pages/Apps Script). */
  siteEnabled: true,
  siteDisabledText: 'Zajrzyj tu za chwilę.',

  /* Klucz panelu admina — musi być IDENTYCZNY jak ADMIN_KEY w Code.gs */
  adminKey: 'twojstaryjekomary',

  /* Limity i zachowanie */
  maxPhotoMB: 20,          // limit dla zdjęć — odrzuca większe z czytelnym komunikatem
  maxVideoMB: 2048,        // limit dla filmów (2 GB)
  maxFilesPerBatch: 40,    // maks. plików wybranych na raz (jedno kliknięcie "Dodaj zdjęcia")
  rateLimitCount: 60,      // maks. plików na urządzenie w oknie czasowym poniżej
  rateLimitWindowMin: 15,  // długość okna czasowego (w minutach) dla limitu powyżej
  parallelUploads: 10,     // ile plików naraz (2 to dobry kompromis na LTE)
  galleryRefreshSec: 30,  // co ile sekund dociągać nowe zdjęcia
  pageSize: 60,           // ile kafelków na stronę galerii
  slideshowIntervalSec: 6 // co ile sekund zmienia się zdjęcie w slideshow.html (telewizor/projektor)
};
