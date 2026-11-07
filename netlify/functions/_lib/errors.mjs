/** 统一错误码（函数侧） */
export const E = Object.freeze({
  E_READONLY: 'E_READONLY',
  E_NOT_FOUND: 'E_NOT_FOUND',
  E_MANIFEST_STALE: 'E_MANIFEST_STALE',
  E_CONFIG_FORBIDDEN: 'E_CONFIG_FORBIDDEN',
  E_INTERNAL: 'E_INTERNAL',
  E_UPSTREAM: 'E_UPSTREAM',
});

export function errorBody(code, message, detail = {}) {
  return { error: { code, message, detail } };
}
