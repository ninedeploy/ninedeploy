import { normalizeInstanceUrl } from '../address.js';

interface ListedInstance {
  id: string;
  name: string;
  origin: string;
  insecure: boolean;
  open: boolean;
  lastOpenedAt?: string;
}

interface LauncherApi {
  status(): Promise<{ persist: boolean; store: string; platform: string }>;
  list(): Promise<ListedInstance[]>;
  add(name: string, address: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  remove(id: string): Promise<{ ok: boolean; revoked: boolean }>;
  open(id: string): Promise<{ ok: true } | { ok: false; reason: string }>;
}

const api = (window as unknown as { launcher: LauncherApi }).launcher;

const STRINGS = {
  en: {
    intro: 'Choose the NineDeploy panel to open. Each one keeps its own sign-in.',
    instances: 'Instances',
    empty: 'No instances yet. Add the address of your panel below.',
    add: 'Add an instance',
    address: 'Panel address',
    name: 'Name (optional)',
    addButton: 'Check and add',
    checking: 'Checking…',
    insecure: 'This address uses plain http: your password and session travel unencrypted, so the app does not keep the sign-in either. Use https unless this is a private network you trust.',
    insecureTag: 'http, unencrypted: sign-in not kept',
    open: 'Open',
    focus: 'Show',
    remove: 'Remove',
    confirmRemove: 'Remove {name}? Its sign-in on this computer is deleted and the session is ended on the panel.',
    removedOffline: '{name} was removed. The panel could not be reached, so its session there ends when it expires.',
    persist: 'Sign-ins are kept encrypted by {store} and survive restarts.',
    noPersist: 'No OS credential store is available ({store}), so you sign in again each time a panel window opens.',
  },
  tr: {
    intro: 'Açılacak NineDeploy panelini seçin. Her birinin oturumu ayrı tutulur.',
    instances: 'Örnekler',
    empty: 'Henüz örnek yok. Aşağıya panelinizin adresini ekleyin.',
    add: 'Örnek ekle',
    address: 'Panel adresi',
    name: 'Ad (isteğe bağlı)',
    addButton: 'Denetle ve ekle',
    checking: 'Denetleniyor…',
    insecure: 'Bu adres şifresiz http kullanıyor: parolanız ve oturumunuz şifrelenmeden iletilir, bu yüzden uygulama oturumu da saklamaz. Güvendiğiniz özel bir ağ değilse https kullanın.',
    insecureTag: 'http, şifresiz: oturum saklanmaz',
    open: 'Aç',
    focus: 'Göster',
    remove: 'Kaldır',
    confirmRemove: '{name} kaldırılsın mı? Bu bilgisayardaki oturumu silinir ve paneldeki oturum sonlandırılır.',
    removedOffline: '{name} kaldırıldı. Panele ulaşılamadı; oradaki oturum süresi dolunca sona erer.',
    persist: 'Oturumlar {store} ile şifreli saklanır ve yeniden başlatmadan sonra da sürer.',
    noPersist: 'İşletim sisteminin kimlik deposu kullanılamıyor ({store}); her panel penceresi açıldığında yeniden oturum açarsınız.',
  },
} as const;

type Key = keyof (typeof STRINGS)['en'];
const lang: keyof typeof STRINGS = navigator.language.toLowerCase().startsWith('tr') ? 'tr' : 'en';
document.documentElement.lang = lang;

function t(key: Key, vars: Record<string, string> = {}): string {
  return STRINGS[lang][key].replace(/\{(\w+)\}/g, (_m, k: string) => vars[k] ?? '');
}

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function button(label: string, onClick: () => void, primary = false): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  if (primary) b.className = 'primary';
  b.addEventListener('click', onClick);
  return b;
}

async function render(): Promise<void> {
  const items = await api.list();
  const list = el<HTMLUListElement>('list');
  list.replaceChildren();
  el('empty').hidden = items.length > 0;
  for (const item of items) {
    const li = document.createElement('li');
    const info = document.createElement('div');
    info.className = 'info';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = item.name;
    const origin = document.createElement('div');
    origin.className = 'origin';
    origin.textContent = item.origin;
    info.append(title, origin);
    if (item.insecure) {
      const tag = document.createElement('div');
      tag.className = 'tag';
      tag.textContent = t('insecureTag');
      info.append(tag);
    }
    const openButton = button(item.open ? t('focus') : t('open'), () => void api.open(item.id).then(render), true);
    const removeButton = button(t('remove'), () => {
      if (!window.confirm(t('confirmRemove', { name: item.name }))) return;
      removeButton.disabled = true;
      void api.remove(item.id).then((result) => {
        if (!result.revoked) showError(t('removedOffline', { name: item.name }));
        return render();
      });
    });
    li.append(info, openButton, removeButton);
    list.append(li);
  }
}

function showError(message: string | null): void {
  const box = el('error');
  box.textContent = message ?? '';
  box.hidden = !message;
}

function wireForm(): void {
  const form = el<HTMLFormElement>('add-form');
  const address = el<HTMLInputElement>('address');
  const name = el<HTMLInputElement>('name');
  const submit = el<HTMLButtonElement>('add-button');
  address.addEventListener('input', () => {
    const normalized = normalizeInstanceUrl(address.value);
    el('insecure').hidden = !(normalized.ok && normalized.insecure);
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    showError(null);
    submit.disabled = true;
    submit.textContent = t('checking');
    void api
      .add(name.value, address.value)
      .then(async (result) => {
        if (!result.ok) {
          showError(result.reason);
          return;
        }
        form.reset();
        el('insecure').hidden = true;
        await render();
      })
      .finally(() => {
        submit.disabled = false;
        submit.textContent = t('addButton');
      });
  });
}

for (const node of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
  node.textContent = t(node.dataset['i18n'] as Key);
}
wireForm();
void api.status().then((status) => {
  el('storage').textContent = status.persist ? t('persist', { store: status.store }) : t('noPersist', { store: status.store });
});
void render();
window.addEventListener('focus', () => void render());
