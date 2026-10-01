'use strict';
const endpoint = (params = {}) => {
  const url = new URL(location.href); url.search = ''; url.hash = '';
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url;
};
let busy = 0;
window.addEventListener('beforeunload', e => { if (busy) { e.preventDefault(); e.returnValue = ''; } });
async function request(params, options = {}, retry = false) {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(endpoint(params), {cache: 'no-store', ...options});
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      return result;
    } catch (error) {
      if (!retry || attempt >= 3) throw error;
      await new Promise(resolve => setTimeout(resolve, 600 * 2 ** attempt));
    }
  }
}
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}
async function main() {
  const data = await request({action: 'groups'});
  const root = document.getElementById('groups'); root.replaceChildren();
  for (const group of data.groups) {
    const card = element('article'); card.dataset.group = group.id;
    const picture = element('img'); picture.src = endpoint({action: 'reference', group: group.id});
    picture.alt = `${group.name} reference photograph`; picture.loading = 'lazy';
    const title = element('h2', group.name);
    const members = element('p', `Contains Approved ${group.members.join(', ')}`, 'members');
    const received = element('p', `${group.received} new files received`, 'received');
    const input = element('input'); input.type = 'file'; input.multiple = true;
    input.accept = '.jpg,.jpeg,.png,.webp,.heic,.heif,.mp4,.mov,.m4v,.webm';
    input.setAttribute('aria-label', `Photos and videos for ${group.name}`);
    const button = element('button', `Upload to ${group.name}`); button.disabled = true;
    const progress = element('progress'); progress.max = 100; progress.value = 0;
    progress.setAttribute('aria-label', `${group.name} upload progress`);
    const status = element('p', 'Choose photos and videos for this face.', 'status'); status.setAttribute('role', 'status');
    let pending = [], receiptCount = group.received;
    input.onchange = () => {
      pending = [...input.files].map(file => ({file, id: null, offset: 0, done: false}));
      button.disabled = !pending.length;
      status.className = 'status'; status.textContent = `${pending.length} files selected for ${group.name}.`;
    };
    button.onclick = async () => {
      if (!pending.length) return;
      input.disabled = button.disabled = true; busy++;
      try {
        for (const item of pending) {
          if (item.done) continue;
          const file = item.file;
          if (file.size <= 0 || file.size > data.maxFileBytes) throw new Error(`${file.name}: file must be between 1 byte and 2 GB.`);
          status.className = 'status';
          if (!item.id) {
            const response = await request({action: 'begin'}, {method: 'POST', headers: {'Content-Type': 'application/json'},
              body: JSON.stringify({group: group.id, name: file.name, size: file.size})});
            item.id = response.id;
          }
          while (item.offset < file.size) {
            status.textContent = `${pending.filter(p => p.done).length}/${pending.length} saved · ${file.name} · ${Math.floor(item.offset / file.size * 100)}%`;
            const end = Math.min(file.size, item.offset + data.chunkBytes);
            const response = await request({action: 'chunk', group: group.id, id: item.id, offset: item.offset},
              {method: 'PUT', headers: {'Content-Type': 'application/octet-stream'}, body: file.slice(item.offset, end)}, true);
            item.offset = response.offset;
            progress.value = pending.reduce((sum, p) => sum + p.offset, 0) / pending.reduce((sum, p) => sum + p.file.size, 0) * 100;
          }
          status.textContent = `Verifying ${file.name}…`;
          await request({action: 'finish', group: group.id, id: item.id}, {method: 'POST'}, true);
          item.done = true; receiptCount++;
          received.textContent = `${receiptCount} new files received`;
        }
        status.className = 'status success'; status.textContent = `Saved ${pending.length} files to ${group.name}. Return to the chat when all groups are done.`;
        pending = []; input.value = ''; progress.value = 100;
      } catch (error) {
        status.className = 'status error'; status.textContent = `${error.message} Keep this page open and press Retry to continue.`;
        button.textContent = `Retry ${group.name}`;
      } finally {
        busy--; input.disabled = false; button.disabled = !pending.length;
        if (!pending.length) button.textContent = `Upload to ${group.name}`;
      }
    };
    card.append(picture, title, members, received, input, button, progress, status); root.append(card);
  }
}
main().catch(error => { document.getElementById('groups').textContent = `Could not load the upload page: ${error.message}. Check that the PC is awake, then refresh.`; });
