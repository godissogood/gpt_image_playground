import { describe, expect, it } from 'vitest'
import { getApiErrorMessage } from './imageApiShared'

describe('getApiErrorMessage', () => {
  it('formats Cloudflare 524 HTML errors into a friendly message', async () => {
    const response = new Response(
      '<!DOCTYPE html><html><head><title>524 A timeout occurred</title></head><body>Cloudflare</body></html>',
      {
        status: 524,
        headers: {
          'Content-Type': 'text/html; charset=UTF-8',
        },
      },
    )

    await expect(getApiErrorMessage(response)).resolves.toContain('Cloudflare 等太久了')
  })

  it('formats generic HTML gateway timeout errors into a friendly message', async () => {
    const response = new Response(
      '<html><body>504 Gateway Timeout</body></html>',
      {
        status: 504,
        headers: {
          'Content-Type': 'text/html',
        },
      },
    )

    await expect(getApiErrorMessage(response)).resolves.toContain('请先试试开启流式输出')
  })

  it('keeps JSON api error messages unchanged', async () => {
    const response = new Response(
      JSON.stringify({ error: { message: 'invalid api key' } }),
      {
        status: 401,
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )

    await expect(getApiErrorMessage(response)).resolves.toBe('invalid api key')
  })
})
