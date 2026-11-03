const form = document.getElementById('form');
const title = document.getElementById('title');
const input = document.getElementById('name');
const cancel = document.getElementById('cancel');

window.ask.init().then((data) => {
  title.textContent = (data && data.title) || '';
  input.value = (data && data.value) || '';
  input.focus();
  input.select();
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const value = input.value.trim();
  if (!value) return;
  window.ask.answer(value);
});

cancel.addEventListener('click', () => window.ask.answer(null));

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    window.ask.answer(null);
  }
});
