export function redact(value) {
  if (typeof value === 'string') return value
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/((?:^|\n)\s*(?:-\s*)?(?:authorization|proxy-authorization|cookie|set-cookie)\s*:\s*)[^\r\n]*/gi, '$1[REDACTED]')
    .replace(/([?&](?:poc_token|access_token|token|api_key)=)[^&\s"<>]+/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@');
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,/^(?:authorization|proxy-authorization|cookie|set-cookie|bearerToken|accessToken|apiKey|password)$/i.test(k)?'[REDACTED]':redact(v)]));
  return value;
}
