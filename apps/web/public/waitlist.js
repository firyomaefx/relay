const form = document.getElementById('waitlistForm');
const message = document.getElementById('message');
const submit = document.getElementById('submit');
const formCard = document.getElementById('formCard');
const successCard = document.getElementById('successCard');
const title = document.getElementById('position');
const spots = document.getElementById('spots');
const successText = document.getElementById('successText');

async function loadStatus() {
  try {
    const r = await fetch('/api/waitlist', { headers: { accept: 'application/json' } });
    const d = await r.json();
    if (!d.open) {
      spots.textContent = 'First batch full';
      formCard.hidden = true;
      successCard.style.display = 'block';
      successCard.querySelector('h2').textContent = 'The first batch is full.';
      title.textContent = '';
      successText.textContent = 'Public access is opening next. Follow Relay for the announcement.';
      return;
    }
    if (Number.isFinite(d.remaining)) {
      spots.textContent = d.remaining + ' of ' + d.limit + ' places left';
    }
  } catch { /* the form still works if status is unavailable */ }
}
loadStatus();

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  message.textContent = '';
  message.className = 'msg';
  submit.disabled = true;
  const platforms = [...form.querySelectorAll('input[name="platform"]:checked')].map((input) => input.value);
  const body = {
    name: form.elements.namedItem('name').value,
    email: form.email.value,
    platforms,
    volume: form.volume.value,
    use_case: form.use_case.value + (form.agent.value ? '\nAgent: ' + form.agent.value : ''),
    website: form.website.value,
    consent: form.consent.checked,
  };
  try {
    const response = await fetch('/api/waitlist', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Could not join the waitlist.');
    formCard.hidden = true;
    successCard.style.display = 'block';
    title.textContent = data.position ? '#' + data.position : 'Received';
    successText.textContent = data.duplicate
      ? 'You were already on the list. We have your request.'
      : 'We will email you when your Relay Cloud account is ready.';
  } catch (error) {
    message.textContent = error.message;
    message.className = 'msg error';
  } finally {
    submit.disabled = false;
  }
});
