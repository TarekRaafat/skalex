# Release Notes

Find release notes/changelog and guides on versioning guidelines

---

## Versioning

---

For transparency and insight into the release cycle, releases will be numbered
with the following format:

`<major>.<minor>.<patch>`

And constructed with the following guidelines:

- Breaking backwards compatibility bumps the major
- New additions without breaking backwards compatibility bumps the minor
- Bug fixes and misc changes bump the patch

For more information on semantic versioning, please visit <http://semver.org/>.

- Release flags:
  - `[Experimental]`: Under testing and might be deprecated at any point
  - `[Deprecated]`: Not developed / supported anymore, might be removed at any point
  - `[Removed]`: Completely gone, no longer exists
  - `[Changed]`: Breaking change in the API or the core library
  - `[Updated]`: Non-breaking change in the API or the core library
  - `[Fixed]`: Bug or Issue that was fixed and no longer exists
  - `[Added]`: New feature

---

## Releases

---

### v1.1.3 ✨

- 🎛️ Updated: Library Documentation

---

### v1.1.2

- 🎛️ Updated: Library Documentation

---

### v1.1.1

- ➕ Added: Library Documentation
- ➕ Added: Comprehensive code comments

---

### v1.1.0

- ➕ Added: `useCollection` to select used collections or creating it if does not exist
- ➕ Added: Collections relations `one-to-one` and `one-to-many`
- ➕ Added:`population` function to populated linked collections
- ➕ Added: `select` function to select returned record values
- ➕ Added: `createdAt` and `updatedAt` values to each record
- 🧹 Cleaned: Project files and some house keeping

---

### v1.0.3

- 🔧 Fixed: NPM package

---

### v1.0.2

- 🔧 Fixed: NPM package

---

### v1.0.1

- 🔧 Fixed: Library reference

---

### v1.0.0

- Initial release