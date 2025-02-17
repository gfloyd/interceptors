import { vi, it, expect, beforeAll, afterAll } from 'vitest'
import express from 'express'
import { IncomingMessage } from 'http'
import { HttpServer } from '@open-draft/test-server/http'
import { DeferredPromise } from '@open-draft/deferred-promise'
import { NodeClientRequest } from './NodeClientRequest'
import { getIncomingMessageBody } from './utils/getIncomingMessageBody'
import { normalizeClientRequestArgs } from './utils/normalizeClientRequestArgs'
import { AsyncEventEmitter } from '../../utils/AsyncEventEmitter'
import { sleep } from '../../../test/helpers'
import { HttpRequestEventMap } from '../../glossary'
import { debug } from '../../utils/debug'

interface ErrorConnectionRefused extends NodeJS.ErrnoException {
  address: string
  port: number
}

const httpServer = new HttpServer((app) => {
  app.post('/comment', (_req, res) => {
    res.status(200).send('original-response')
  })

  app.post('/write', express.text(), (req, res) => {
    res.status(200).send(req.body)
  })
})

const log = debug('test')

beforeAll(async () => {
  await httpServer.listen()
})

afterAll(async () => {
  await httpServer.close()
})

it('gracefully finishes the request when it has a mocked response', async () => {
  const emitter = new AsyncEventEmitter<HttpRequestEventMap>()
  const request = new NodeClientRequest(
    normalizeClientRequestArgs('http:', 'http://any.thing', {
      method: 'PUT',
    }),
    {
      emitter,
      log,
    }
  )

  emitter.on('request', (request) => {
    request.respondWith(
      new Response('mocked-response', {
        status: 301,
        headers: {
          'x-custom-header': 'yes',
        },
      })
    )
  })

  request.end()

  const responseReceived = new DeferredPromise<IncomingMessage>()
  request.on('response', async (response) => {
    responseReceived.resolve(response)
  })
  const response = await responseReceived

  // Request must be marked as finished.
  expect(request.finished).toEqual(true)
  expect(request.writableEnded).toEqual(true)
  expect(request.writableFinished).toEqual(true)
  expect(request.writableCorked).toEqual(0)

  expect(response.statusCode).toEqual(301)
  expect(response.headers).toHaveProperty('x-custom-header', 'yes')

  const text = await getIncomingMessageBody(response)
  expect(text).toEqual('mocked-response')
})

it('responds with a mocked response when requesting an existing hostname', async () => {
  const emitter = new AsyncEventEmitter<HttpRequestEventMap>()
  const request = new NodeClientRequest(
    normalizeClientRequestArgs('http:', httpServer.http.url('/comment')),
    {
      emitter,
      log,
    }
  )

  emitter.on('request', (request) => {
    request.respondWith(new Response('mocked-response', { status: 201 }))
  })

  request.end()

  const responseReceived = new DeferredPromise<IncomingMessage>()
  request.on('response', async (response) => {
    responseReceived.resolve(response)
  })
  const response = await responseReceived

  expect(response.statusCode).toEqual(201)

  const text = await getIncomingMessageBody(response)
  expect(text).toEqual('mocked-response')
})

it('performs the request as-is given resolver returned no mocked response', async () => {
  const emitter = new AsyncEventEmitter<HttpRequestEventMap>()
  const request = new NodeClientRequest(
    normalizeClientRequestArgs('http:', httpServer.http.url('/comment'), {
      method: 'POST',
    }),
    {
      emitter,
      log,
    }
  )

  request.end()

  const responseReceived = new DeferredPromise<IncomingMessage>()
  request.on('response', async (response) => {
    responseReceived.resolve(response)
  })
  const response = await responseReceived

  expect(request.finished).toEqual(true)
  expect(request.writableEnded).toEqual(true)

  expect(response.statusCode).toEqual(200)
  expect(response.statusMessage).toEqual('OK')
  expect(response.headers).toHaveProperty('x-powered-by', 'Express')

  const text = await getIncomingMessageBody(response)
  expect(text).toEqual('original-response')
})

it('emits the ENOTFOUND error connecting to a non-existing hostname given no mocked response', async () => {
  const emitter = new AsyncEventEmitter<HttpRequestEventMap>()
  const request = new NodeClientRequest(
    normalizeClientRequestArgs('http:', 'http://non-existing-url.com'),
    { emitter, log }
  )
  request.end()

  const errorReceived = new DeferredPromise<NodeJS.ErrnoException>()
  request.on('error', async (error) => {
    errorReceived.resolve(error)
  })
  const error = await errorReceived

  expect(error.code).toEqual('ENOTFOUND')
  expect(error.syscall).toEqual('getaddrinfo')
})

it('emits the ECONNREFUSED error connecting to an inactive server given no mocked response', async () => {
  const emitter = new AsyncEventEmitter<HttpRequestEventMap>()
  const request = new NodeClientRequest(
    normalizeClientRequestArgs('http:', 'http://127.0.0.1:12345'),
    {
      emitter,
      log,
    }
  )

  request.end()

  const errorReceived = new DeferredPromise<ErrorConnectionRefused>()
  request.on('error', async (error: ErrorConnectionRefused) => {
    errorReceived.resolve(error)
  })
  request.end()

  const error = await errorReceived

  expect(error.code).toEqual('ECONNREFUSED')
  expect(error.syscall).toEqual('connect')
  expect(error.address).toEqual('127.0.0.1')
  expect(error.port).toEqual(12345)
})

it('does not emit ENOTFOUND error connecting to an inactive server given mocked response', async () => {
  const emitter = new AsyncEventEmitter<HttpRequestEventMap>()
  const handleError = vi.fn()
  const request = new NodeClientRequest(
    normalizeClientRequestArgs('http:', 'http://non-existing-url.com'),
    { emitter, log }
  )

  emitter.on('request', async (request) => {
    await sleep(250)
    request.respondWith(
      new Response(null, { status: 200, statusText: 'Works' })
    )
  })

  request.end()

  request.on('error', handleError)

  const responseReceived = new DeferredPromise<IncomingMessage>()
  request.on('response', (response) => {
    responseReceived.resolve(response)
  })
  const response = await responseReceived

  expect(handleError).not.toHaveBeenCalled()
  expect(response.statusCode).toEqual(200)
  expect(response.statusMessage).toEqual('Works')
})

it('does not emit ECONNREFUSED error connecting to an inactive server given mocked response', async () => {
  const emitter = new AsyncEventEmitter<HttpRequestEventMap>()
  const handleError = vi.fn()
  const request = new NodeClientRequest(
    normalizeClientRequestArgs('http:', 'http://localhost:9876'),
    {
      emitter,
      log,
    }
  )

  emitter.on('request', async (request) => {
    await sleep(250)
    request.respondWith(
      new Response(null, { status: 200, statusText: 'Works' })
    )
  })

  request.on('error', handleError)
  request.end()

  const responseReceived = new DeferredPromise<IncomingMessage>()
  request.on('response', (response) => {
    responseReceived.resolve(response)
  })
  const response = await responseReceived

  expect(handleError).not.toHaveBeenCalled()
  expect(response.statusCode).toEqual(200)
  expect(response.statusMessage).toEqual('Works')
})

it('sends the request body to the server given no mocked response', async () => {
  const emitter = new AsyncEventEmitter<HttpRequestEventMap>()
  const request = new NodeClientRequest(
    normalizeClientRequestArgs('http:', httpServer.http.url('/write'), {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
      },
    }),
    {
      emitter,
      log,
    }
  )

  request.write('one')
  request.write('two')
  request.end('three')

  const responseReceived = new DeferredPromise<IncomingMessage>()
  request.on('response', (response) => {
    responseReceived.resolve(response)
  })
  const response = await responseReceived

  expect(response.statusCode).toEqual(200)

  const text = await getIncomingMessageBody(response)
  expect(text).toEqual('onetwothree')
})

it('does not send request body to the original server given mocked response', async () => {
  const emitter = new AsyncEventEmitter<HttpRequestEventMap>()
  const request = new NodeClientRequest(
    normalizeClientRequestArgs('http:', httpServer.http.url('/write'), {
      method: 'POST',
    }),
    {
      emitter,
      log,
    }
  )

  emitter.on('request', async (request) => {
    await sleep(200)
    request.respondWith(new Response('mock created!', { status: 301 }))
  })

  request.write('one')
  request.write('two')
  request.end()

  const responseReceived = new DeferredPromise<IncomingMessage>()
  request.on('response', (response) => {
    responseReceived.resolve(response)
  })
  const response = await responseReceived

  expect(response.statusCode).toEqual(301)

  const text = await getIncomingMessageBody(response)
  expect(text).toEqual('mock created!')
})
