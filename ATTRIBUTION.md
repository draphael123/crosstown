# Attribution

## Music

All music in `music/` is by **Kevin MacLeod** (incompetech.com), used under the
**Creative Commons Attribution 4.0** licence.

> Music by Kevin MacLeod — <https://incompetech.com>
> Licensed under Creative Commons: By Attribution 4.0
> <https://creativecommons.org/licenses/by/4.0/>

Fetched from the Internet Archive item
[`kevin-macleod-music-col`](https://archive.org/details/kevin-macleod-music-col)
and re-encoded to 96 kbps stereo from the archive's VBR masters, purely to keep
the repository a sane size. `music/manifest.json` lists every track shipped.

That archive item is tagged Public Domain Mark, but MacLeod's own terms are
CC BY, so this project attributes under CC BY — the stricter of the two, and the
one the composer actually publishes under.

### A note on why none of this is a real 1955 recording

It would be the obvious thing to reach for, and it is not available. Sound
recordings published in 1955 are **still under copyright in the United States**:
the Music Modernization Act brought pre-1972 recordings under federal protection
and releases them on a rolling schedule that has so far only reached the
mid-1920s. Anything that genuinely sounds like 1955 because it *is* 1955 is
therefore off limits, whatever a search result might imply. The tracks here are
modern, freely licensed pieces chosen for period feel — jazz, swing, ragtime,
lounge and light Americana.

## Sound

Everything else you hear — the country and traffic beds, the works whistle, the
church bell, the birds — is synthesised at runtime in `src/audio.js`. There are
no sound files and nothing to license.

## Code

three.js (r160) is vendored in `vendor/`, MIT licensed.
