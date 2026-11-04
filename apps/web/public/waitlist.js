const form = document.getElementById('waitlistForm');
const message = document.getElementById('message');
const submit = document.getElementById('submit');
const formCard = document.getElementById('formCard');
const successCard = document.getElementById('successCard');
const title = document.getElementById('position');
const spots = document.getElementById('spots');
const successText = document.getElementById('successText');
const countrySelect = document.getElementById('phoneCountry');
const countries = Array.isArray(window.RELAY_COUNTRIES) ? window.RELAY_COUNTRIES : [
  { code: 'MY', name: 'Malaysia', dial: '+60', flag: '🇲🇾' },
];
countrySelect.innerHTML = countries
  .map((country) => `<option value="${country.code}">${country.flag ? country.flag + ' ' : ''}${country.name} (${country.dial})</option>`)
  .join('');
countrySelect.value = 'MY';

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
  const country = countries.find((item) => item.code === countrySelect.value) || countries[0];
  const localPhone = form.phone.value.replace(/\D/g, '').replace(/^0+/, '');
  const body = {
    name: form.elements.namedItem('name').value,
    email: form.email.value,
    phone: localPhone ? country.dial + localPhone : '',
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
      : data.emailSent
        ? 'Check your inbox — we sent a confirmation. We will email you when your access is ready.'
        : 'We have your request. We will contact you when your Relay Cloud account is ready.';
  } catch (error) {
    message.textContent = error.message;
    message.className = 'msg error';
  } finally {
    submit.disabled = false;
  }
});
