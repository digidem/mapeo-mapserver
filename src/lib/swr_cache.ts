/* eslint-disable @typescript-eslint/no-empty-function */
import got from 'got'
import { LevelUp } from 'levelup'
import { AbstractLevelDOWN } from 'abstract-leveldown'
import PromiseAny from 'promise.any'

PromiseAny.shim()

class SWRCache {
  private etagDb: LevelUp<AbstractLevelDOWN<string, string>>
  private cacheDb: LevelUp<AbstractLevelDOWN<string, Buffer>>
  private inflight = new Map<string, Promise<Buffer>>()
  private pending = new Set<Promise<any>>()

  constructor({
    etagDb,
    cacheDb,
  }: {
    etagDb: SWRCache['etagDb']
    cacheDb: SWRCache['cacheDb']
  }) {
    this.etagDb = etagDb
    this.cacheDb = cacheDb
  }

  get(
    url: string,
    {
      forceOffline,
      cacheGet = () => this.cacheDb.get(url),
      cachePut = (buf: Buffer) => this.cacheDb.put(url, buf),
    }: {
      forceOffline?: boolean
      // This is used by tilestore, which uses mbtiles as the "cache"
      cacheGet?: () => Promise<Buffer>
      cachePut?: (buf: Buffer) => Promise<void>
    } = {}
  ): Promise<Buffer> {
    // If there is already an inflight request for this url, use that
    const inflightRequest = this.inflight.get(url)
    if (inflightRequest) return inflightRequest

    // Get the resource either from the cache or from upstream, but unless
    // forceOffline is true, always try to revalidate the cache
    const request = forceOffline
      ? Promise.any([cacheGet()])
      : Promise.any([cacheGet(), this.getUpstream(url, { cachePut })])
    this.inflight.set(url, request)
    // Warning: Using .finally() here will result in an unhandled rejection
    request
      .then(() => this.inflight.delete(url))
      .catch(() => this.inflight.delete(url))
    return request
  }

  /**
   * Wait until all pending requests have completed (this is necessary because
   * swrCache.get() will return a value from the cache while a request will be
   * sent upstream to revalidate the cache. This method allows you to wait for
   * pending revalidation requests to complete)
   */
  allSettled(): Promise<void> {
    return Promise.allSettled(this.pending).then(() => {})
  }

  /**
   * Request a URL, respecting cached headers, and update the cache
   */
  private getUpstream(
    url: string,
    {
      cachePut,
    }: {
      cachePut: (buf: Buffer) => Promise<void>
    }
  ): Promise<Buffer> {
    /**
     * 1. Get etag for currently cached resource, if it exists
     * 2. Request resource, if it does not match etag
     * 3. Throw if the resouce has not been modified (cached value is up-to-date)
     * 4. Otherwise save the etag and cache the resource
     */
    const request = this.etagDb
      .get(url)
      .catch(() => {
        /** ignore error, just not cached yet */
      })
      .then((etag) => {
        const headers = etag ? { 'If-None-Match': etag } : {}
        return got(url, { headers, responseType: 'buffer' })
      })
      .then((response) => {
        if (response.statusCode === 304) throw new Error('Not Modified')
        const etag = response.headers.etag as string
        // Don't await these, they can happen after response is returned
        // TODO: How to handle errors here? Logging?
        this.etagDb.put(url, etag).catch(() => {})
        cachePut(response.body).catch(() => {})
        return response.body
      })
    // Keep track of this pending request, for the allSettled() method
    this.pending.add(request)
    request
      .then(() => this.pending.delete(request))
      .catch(() => this.pending.delete(request))
    return request
  }
}

export default SWRCache
