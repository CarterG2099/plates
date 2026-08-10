# Exercise drawings

Drop PNGs here, named `<slug>.png` — the full list of filenames is in
`exercise-art.md` at the repo root, along with the prompt used to generate them.

The app derives the slug from the exercise name, tries to load the file, and
falls back to the drawn muscle map when there isn't one. So adding an image is
just adding the file: no upload, no database write, nothing to keep in sync.

Not precached by the service worker. There could eventually be a hundred of
these and they are not needed for the app to work offline — they load over the
network and the browser caches them normally.
