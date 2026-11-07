/**
 * response.mjs — 统一 CORS / 预检 / 只读约束 / 错误封装
 * 三个函数全部仅 GET + OPTIONS；其它方法一律 405 E_READONLY。
 */
import { E, errorBody } from './errors.mjs';

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
  'Access-Control-Expose-Headers': 'Allow',
  'Allow': 'GET,OPTIONS',
  'Vary': 'Origin',
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'public, max-age=300',
  'X-Content-Type-Options': 'nosniff',
};

export const handler = (fn) => async (event) => {
  const method = (event.httpMethod || 'GET').toUpperCase();
  if (method === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (method !== 'GET') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify(errorBody(E.E_READONLY, 'API 为只读，不支持 ' + method)) };
  }
  try {
    return await fn(event);
  } catch (err) {
    const code = err?.code || E.E_INTERNAL;
    return { statusCode: code === E.E_NOT_FOUND ? 404 : 500, headers: CORS,
      body: JSON.stringify(errorBody(code, err?.message || '内部错误', { stack: String(err?.stack || '').split('\n').slice(0, 5) })) };
  }
};

export const ok = (data) => ({ statusCode: 200, headers: CORS, body: JSON.stringify(data) });
