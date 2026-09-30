# What's new

Every change to Subtitle Sync for Stremio that people can notice, newest first. The same
list, in English and Serbian: https://subtitlesync.stream/changelog

- **2026-09-30** Spanish is now two languages to choose from: Spanish (Latin America) and Spanish (Spain). Latin American subtitles show in Stremio as Español (América Latina), so Stremio can pick them by itself; choose both to get the other kind when yours has none. Most Spanish subtitles do not say which kind they are, so the addon reads each one it downloads and remembers what it found; a subtitle of the other kind is still offered, after all of yours. Installs that chose plain Spanish before get both kinds in one list, as before, and Latin American subtitles are no longer put after the others there.
- **2026-09-30** Subtitles whose lines are held long or merged (many Arabic translations, for example) now sync: the matching judges a shift a third way, by where each line starts, which does not care how long the lines are. Measured on real files that were refused before; unrelated films stay refused.
- **2026-09-30** A subtitle in your own language made for the same release as your file now serves as the timing reference for the other subtitles of that language, not only an English one. For a dubbed release it is often the only one that exists. The list downloads nothing extra for it.
- **2026-09-30** When nothing can line a subtitle up (no stream addon, a web stream), the list is now ordered by how alike your file each subtitle's release is: the same source and group first, a CAM copy last. A subtitle made for the same release as your file is marked 🟠 Same release as your file and comes before the ⚠️ Not synced ones. Before, such lists were ordered by download count, and the first subtitle was in sync about one time in three.
- **2026-09-30** A video file is now recognised by its fingerprint alone. Some stream addons announce a file size a few percent off the real one, and Stremio passes that size on; until now it stopped the addon from reading the subtitle track inside the file.
- **2026-09-30** When your OpenSubtitles downloads for the day are used up, the list now puts subtitles from your other sites first, and one row at the end says when OpenSubtitles comes back. The message in the player names only the sites you have.
- **2026-09-30** Stremio Web and the TV apps show the first subtitle list they get, made before Stremio knows your video file's fingerprint. Subtitles picked from it are now lined up with what the second list finds by that fingerprint, instead of served untimed.
- **2026-09-30** SubDL season packs that come as RAR archives now work: you get the episode you are watching. A subtitle file that still cannot be opened now says so in the player, instead of showing nothing.
- **2026-09-30** An app that adds the addon without its setup now shows one subtitle that says where to set it up, instead of nothing.
- **2026-09-29** The setup page now says when your stream addon also gives Stremio subtitles of its own (AIOStreams can), which are not synced, and where to switch them off.
- **2026-09-29** Every box you paste into now has Paste and Show buttons, the stream addon link and the OpenSubtitles login too. The stream addon link is hidden while you type it.
- **2026-09-29** The FAQ says more exactly what the server records: the video file's size and hash, the numbers of the subtitles offered, and how well each one lined up.
- **2026-09-29** MP4 videos: the subtitles inside them are now read too, so subtitles can be lined up with the video itself, as with MKV.
- **2026-09-29** More subtitles sync: one with far fewer lines than the video's own subtitles now lines up too, and every OpenSubtitles result is looked at, not only the first fifty.
- **2026-09-29** A reload no longer loses your setup: the step you were on, your choices and your keys come back. They are kept only in that browser tab and are gone when you close it, or at once with "Start over".
- **2026-09-29** The note at the end of a subtitle now names the website, subtitlesync.stream.
- **2026-09-28** OpenSubtitles is now required, with your free account's login: it is what lines subtitles up when the video's own subtitles can't be read. Each site in step 2 says whether it is free or paid.
- **2026-09-28** New address: subtitlesync.stream.
- **2026-09-28** Serbian and Bosnian subtitles are always served in Latin script, and the end-of-film note is in Latin too.
- **2026-09-28** SubDL and SubSource added as sources, each with your own free key.
- **2026-09-27** Setup has five steps, with a checklist that ticks itself when a check passes, and a last step for Stremio's own settings.
- **2026-09-26** Every language on the setup page reviewed: search names, scripts and the order subtitles are offered in.
- **2026-09-25** "Test my setup" checks every key and link at once, and notices in the player say what went wrong when something did.
- **2026-09-24** Your first language is checked before the menu appears, and a subtitle that lines up is put on top.
- **2026-09-23** The guided setup page, in English and Serbian.
