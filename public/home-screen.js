// The web door on the home screen (/manifest.webmanifest): where the browser has an install prompt (Chrome, Edge,
// Samsung Internet) the page offers it; on iPhone and iPad it says where Safari's button is. The icon, name and
// start address follow the resident the page is on, so each resident can have its own icon.

// The browser's prompt comes once, often before the page has started: keep it for the button.
var homePrompt = null;
addEventListener('beforeinstallprompt', function (event) {
  // The page asks in its own card instead of the browser's banner.
  event.preventDefault();
  homePrompt = event;
  dispatchEvent(new Event('home-screen'));
});
addEventListener('appinstalled', function () {
  homePrompt = null;
  dispatchEvent(new Event('home-screen'));
});

function homeScreenPage() {
  function remembered() { try { return localStorage.getItem('resident.home.ask') || ''; } catch (e) { return ''; } }
  return {
    // can: 'prompt' (the browser's install prompt), 'ios' (Safari's Share → Add to Home Screen) or '' (nothing to offer).
    home: { can: '', asked: remembered() },
    prepareHome() {
      var self = this;
      addEventListener('home-screen', function () { self.home.can = self.homeWay(); });
      this.home.can = this.homeWay();
      this.followHome();
      if (this.$watch) {
        this.$watch('resident', function () { self.followHome(); });
        this.$watch('identity', function () { self.followHome(); });
      }
    },
    homeWay() {
      if (this.miniApp || (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform())) return '';
      var nav = window.navigator || {};
      if ((window.matchMedia && matchMedia('(display-mode: standalone)').matches) || nav.standalone) return '';
      if (homePrompt) return 'prompt';
      var ua = nav.userAgent || '';
      return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && nav.maxTouchPoints > 1) ? 'ios' : '';
    },
    // Asked once in the chat on a phone or tablet, after the notifications card, until she adds it or says not now.
    homeInvite() {
      var touch = window.matchMedia && matchMedia('(pointer: coarse)').matches;
      return Boolean(this.home.can) && touch && this.home.asked !== 'no' && this.lines.length > 2 && !this.pushInvite();
    },
    dismissHome() {
      this.home.asked = 'no';
      try { localStorage.setItem('resident.home.ask', 'no'); } catch (e) {}
    },
    async addToHome() {
      var prompt = homePrompt;
      if (!prompt) return;
      // A prompt is good for one ask; the browser sends a new one if it may ask again.
      homePrompt = null;
      this.home.can = this.homeWay();
      try {
        await prompt.prompt();
        if ((await prompt.userChoice).outcome === 'accepted') this.dismissHome();
      } catch (e) {}
    },
    // The icon, name and first address the home screen takes: the resident's on the page.
    followHome() {
      if (!document.querySelector) return;
      var link = document.querySelector('link[rel="manifest"]');
      if (link) link.setAttribute('href', this.resident && this.resident !== 'default' ? '/r/' + this.resident + '/manifest.webmanifest' : '/manifest.webmanifest');
      // Safari takes this one over the manifest's icons.
      var icon = document.querySelector('link[rel="apple-touch-icon"]');
      if (icon) icon.setAttribute('href', (this.identity && this.identity.avatar) || '/icon-192.png');
      if (this.identity && this.identity.name) document.title = this.identity.name;
    }
  };
}
