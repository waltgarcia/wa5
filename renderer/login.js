const $ = (id) => document.getElementById(id);
let mode = 'setup';

function showError(message) { $('error').textContent = message || ''; }

async function start() {
  const status = await window.access.state();
  if (status.configured) {
    mode = 'unlock';
    $('title').textContent = 'Enter WA5';
    $('subtitle').textContent = 'Type your password to open the accounts.';
    $('profile-group').classList.add('hidden');
    $('repeat-group').classList.add('hidden');
    $('action').textContent = 'Enter';
    if (status.touchId) $('touch-button').classList.remove('hidden');
  } else {
    mode = 'setup';
  }
  $('password').focus();
}

$('touch-button').addEventListener('click', async () => {
  showError('');
  const result = await window.access.touchId();
  if (!result.ok) showError(result.error);
});

$('form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  showError('');
  $('action').disabled = true;

  try {
    if (mode === 'setup') {
      const profile = $('profile').value.trim();
      const first = $('password').value;
      const second = $('repeat').value;
      if (!profile) return showError('Type the profile name.');
      if (first.length < 6) return showError('The password must be at least 6 characters.');
      if (first !== second) return showError('The two passwords do not match.');
      const result = await window.access.configure(profile, first);
      if (!result.ok) return showError(result.error);
    } else {
      const result = await window.access.unlock($('password').value);
      if (!result.ok) {
        showError(result.error);
        $('password').value = '';
        $('password').focus();
      }
    }
  } finally {
    $('action').disabled = false;
  }
});

start();
