// Menu text & per-command help (English).
module.exports = {
  "menu.text": `
✨ *AGEMASEN BOT* ✨

Fufu... welcome, Trainer-san. Here's the list of available commands. For crypto analysis, just tag me or reply to my messages~

┏━━━━━━━━━━━━━━━┓
┃ 🔎 *IMAGE SEARCH*
┗━━━━━━━━━━━━━━━┛
▸ !img
▸ !pin
▸ !pixiv
▸ !next
▸ !id

┏━━━━━━━━━━━━━━━┓
┃ 🎞️ *GIF SEARCH*
┗━━━━━━━━━━━━━━━┛
▸ !gif

┏━━━━━━━━━━━━━━━┓
┃ 🏇 *UMA MUSUME*
┗━━━━━━━━━━━━━━━┛
▸ !trainer
▸ !club
▸ !threshold
▸ !leaderboard

┏━━━━━━━━━━━━━━━┓
┃ 🎨 *STICKERS*
┗━━━━━━━━━━━━━━━┛
▸ !meme
▸ !smeme
▸ !s
▸ !sbrat
▸ !gifbrat
▸ !schat
▸ !togif
▸ !toimg

┏━━━━━━━━━━━━━━━┓
┃ 📥 *MEDIA DOWNLOAD*
┗━━━━━━━━━━━━━━━┛
▸ !dl
▸ !dlr
▸ !dlt

┏━━━━━━━━━━━━━━━┓
┃ 🖼️ *AI UPSCALE*
┗━━━━━━━━━━━━━━━┛
▸ !hd

┏━━━━━━━━━━━━━━━┓
┃ 📄 *DOCUMENTS*
┗━━━━━━━━━━━━━━━┛
▸ !summarize
▸ !article

┏━━━━━━━━━━━━━━━┓
┃ 📈 *CRYPTO ANALYSIS*
┗━━━━━━━━━━━━━━━┛
▸ !analysis
▸ !chart
▸ !price
▸ !level
▸ !ema
▸ !trend
▸ !mtf
▸ !compare
▸ !listcrypto
▸ !all
▸ !top
▸ !flop
▸ !categories
▸ !search

┏━━━━━━━━━━━━━━━┓
┃ 💬 *AI CHAT*
┗━━━━━━━━━━━━━━━┛
▸ Tag me (@AgemasenBot) to chat
▸ Or reply to my message to keep talking
▸ !forget

┏━━━━━━━━━━━━━━━┓
┃ ⚙️ *MISC*
┗━━━━━━━━━━━━━━━┛
▸ !groupinfo
▸ !online
▸ !botstatus
▸ !subscription
▸ !lang
▸ !ping
▸ !menu

━━━━━━━━━━━━━━━━━━

Not sure how to use a command? Just type it (even if it's wrong or incomplete) and I'll explain how it works myself.

...I-it's not like I care about you or anything. I just hate having the same question asked over and over.
`,

  "cmd.img": `🔎 *!img <tag>*

Search images by tag.
_(If the tag is too generic, you'll get a list of choices. Just reply with the number.)_

Every search result comes with a *Session Code* (a number). Anyone in the group can type that number to get another image from the same search -- it doesn't have to be the person who started it, and it won't get mixed up with other searches because each search has its own code.

*Examples:*
\`\`\`
!img special week
!img special week, silence suzuka
!img tokai_teio_(umamusume)
\`\`\`

You don't need to write the exact Safebooru tag: just type the name with spaces and a list of matching tags will appear -- reply with the number. If you type several characters, separate them with commas. The lists appear one by one, then an image containing all of them is sent. The old underscore style still works.

*Want more than 1 image?* Add *#count* at the very end (max 100, 10+ images are sent as a .zip file):
\`\`\`
!img special week #8
!img special week, silence suzuka #5
\`\`\`

"Uchiha" has way too many results... that's why you pick one of the numbers shown. Do I really have to explain something this obvious...`,

  "cmd.pin": `📌 *!pin <keyword>*

Search Pinterest images by keyword.

Just like *!img*, every search result comes with a *Session Code*. Anyone in the group can type that number (or *!next*) to get another image from the same search.

*Examples:*
\`\`\`
!pin sunset aesthetic
!pin cute cat
!pin minimalist bedroom design
\`\`\`

*Want more than 1 image?* Add *#count* at the very end (max 100, 10+ images are sent as a .zip file):
\`\`\`
!pin special week #8
!pin cute cat #5
\`\`\`
The Session Code appears on the last image.

⚠️ This uses Pinterest's internal search (not an official API), so it may occasionally fail or change without notice -- if that happens, try again in a bit.`,

  "cmd.pixiv": `🎨 *!pixiv <keyword>*

Search Pixiv illustrations by keyword. *Safe mode only* -- adult content (R-18 etc.) is filtered out automatically.

Just like *!pin*, every search result comes with a *Session Code*. Anyone in the group can type that number (or *!next*) to get another illustration from the same search.

*Examples:*
\`\`\`
!pixiv special week
!pixiv landscape
!pixiv 風景
\`\`\`

*Want more than 1 image?* Add *#count* at the very end (max 100, 10+ images are sent as a .zip file):
\`\`\`
!pixiv special week #8
!pixiv landscape #5
\`\`\`
The Session Code appears on the first image, together with the list of artwork links.

⚠️ This uses Pixiv's internal endpoint (not an official API), so it may occasionally fail or change without notice -- if that happens, try again in a bit.`,

  "cmd.gif": `🎞️ *!gif <keyword>*

Search GIFs (Tenor first, GIPHY as a fallback if Tenor fails/returns nothing) by keyword, then send 1 RANDOM result to the chat.

Just like *!img*/*!pin*, every search result comes with a *Session Code*. Anyone in the group can type that number (or *!next*) to get another GIF from the same search, without searching from scratch.

*Examples:*
\`\`\`
!gif special week uma
!gif anime reaction
!gif funny cat
\`\`\`

Case doesn't matter (*!GIF* works too), and extra spaces are cleaned up automatically.`,

  "cmd.next": `➡️ *!next*

Go to the next result of the same tag/keyword search (from *!img*, *!pin*, *!pixiv*, or *!gif*).

💡 Besides typing *!next*, you can also type the *Session Code* (the number shown in the result) -- anyone in the group can use it, not just whoever started the search.

⚠️ Use *!img <tag>*, *!pin <keyword>*, *!pixiv <keyword>*, or *!gif <keyword>* first before using this.`,

  "cmd.id": `🆔 *!id <code>*

Open a specific image again using its ID code.

*Example:*
\`\`\`
!id 12345
\`\`\``,

  "cmd.meme": `🎨 *!meme <text>*

Turn a GIF/video into an animated sticker with text.

*How to use:*
• Send a GIF/video with the caption \`!meme text\`.
• Or send the GIF/video first, then *reply* to it with \`!meme text\`.

Want two lines? Separate them with \`|\`. Want text on top only? Put a \`|\` after it (default is bottom). WhatsApp emoji work too.

*Example:*
\`\`\`
!meme HELLO WORLD|GOOD MORNING
!meme HELLO |
\`\`\`

(For stickers/photos, use *!smeme* instead)`,

  "cmd.smeme": `🎨 *!smeme <text>*

Turn a sticker (emote) or photo into a sticker with text.

*How to use:*
• Send a sticker/photo with the caption \`!smeme text\`.
• Or send the media first, then *reply* to it with \`!smeme text\`.

Want two lines? Separate them with \`|\`. Want text on top only? Put a \`|\` after it (default is bottom). WhatsApp emoji work too.

*Example:*
\`\`\`
!smeme lmaooooo😂
!smeme HELLO |
\`\`\`

(For GIFs/videos, use *!meme* instead)`,

  "cmd.s": `🎨 *!s*

Turn any GIF/video/sticker/photo into a regular sticker, without text.

*How to use:*
• Send the media with the caption \`!s\`.
• Or send the media first, then *reply* to it with \`!s\`.`,

  "cmd.sbrat": `🖤 *!sbrat <text>*

Turn text into a BRAT-style sticker (white background, black lowercase text in a narrow font, justified, with a "fried" blur effect) -- made purely from text, no media needed.

*How to use:*
Type the text right after the command.

*Examples:*
\`\`\`
!sbrat let's go let's go
!sbrat you only live once
!sbrat so tired today 😭
\`\`\`

💡 You can also use a dot: \`.sbrat your text\`.
💡 Emoji are allowed inside the text (including flags 🇮🇩 and skin-tone emoji 👍🏽), shown as emoji images.

⚠️ Maximum of about 80 characters to keep the sticker layout tidy.`,

  "cmd.gifbrat": `🖤 *!gifbrat <text>*

Make an animated BRAT-style STICKER that "types" word by word: words appear one at a time, and the font size and layout adjust with every new word until the full brat is shown (same result as !sbrat). Made purely from text, no media needed.

*How to use:*
Type the text right after the command.

*Examples:*
\`\`\`
!gifbrat let's go let's go
!gifbrat you only live once
!gifbrat so tired today 😭
\`\`\`

💡 You can also use a dot: \`.gifbrat your text\`.
💡 Emoji are allowed inside the text.

⚠️ Maximum of 30 words / 300 characters since every word becomes one animation frame.`,

  "cmd.schat": `💬 *!schat Name|Message|badge*

Turn text into a dark-mode WhatsApp style "chat dialog" sticker -- round avatar, then a dark bubble with the sender name, message, and time. Made purely from text, no media required.

*How to use:*
Type \`!schat Name|Message\` (the \`|badge\` part at the end is optional, usually a small emoji next to the name).

*The avatar is automatic, no need to upload anything:*
• *Reply* to someone's message in a group, then type \`!schat ...\` -> the avatar is THAT person's profile photo.
• *Tag* someone (@number) in the command text -> the avatar is the tagged person's profile photo.
• No reply/tag -> the avatar is YOUR own profile photo.
• Want to force an avatar from a specific image? Send an image/sticker with the caption \`!schat ...\`, or send the image first then *reply* with \`!schat ...\` -- this has the highest priority.
• If the photo can't be fetched (e.g. their WhatsApp privacy is closed), it automatically falls back to a colored circle with the initial.

*Examples:*
\`\`\`
!schat A.Z.A.N|go easy on the sarcasm please
!schat Budi|Hey, have you guys eaten yet?|😂
\`\`\`

💡 Want bold text? Wrap it in double asterisks: \`**bold**\`.

⚠️ Name max 40 characters, message max 500 characters (this limit is also re-checked in code -- see MAX_NAME_CHARS/MAX_MESSAGE_CHARS in dialogSticker.js).`,

  "cmd.togif": `🎞️ *!togif*

Turn an ANIMATED sticker back into a GIF (sent as a looping video, like a GIF).

*How to use:*
• Send the sticker with the caption \`!togif\`.
• Or send the sticker first, then *reply* with \`!togif\`.

⚠️ Animated stickers only. If the sticker is static (not animated), use *!toimg* instead.`,

  "cmd.toimg": `🖼️ *!toimg*

Turn a sticker into a regular image (PNG). If the sticker is animated, only the first frame is used.

*How to use:*
• Send the sticker with the caption \`!toimg\`.
• Or send the sticker first, then *reply* with \`!toimg\`.`,

  "cmd.dl": `📥 *!dl <link>*

Download video/audio from a link (or *reply* to a message with a link and type *!dl*): YouTube, Bilibili, Facebook (video/reel/video post), TikTok, Instagram, X/Twitter, and other supported sites.

If the link turns out to be a *photo* post (an Instagram carousel, or a TikTok photo+music slideshow), the bot automatically sends all the photos one by one, plus the music (if any) at the end. Or use *!dlr* directly if you already know the link is a photo/carousel.

*Examples:*
\`\`\`
!dl https://youtu.be/xxxxxxxxxxx
!dl https://youtu.be/xxxxxxxxxxx mp3
!dl https://www.tiktok.com/@user/video/xxxxxxxxxxx
!dl https://www.bilibili.com/video/xxxxxxxxxxx
!dl https://www.facebook.com/reel/xxxxxxxxxxx
!dl https://www.instagram.com/p/xxxxxxxxxxx
\`\`\`

You can add *mp3* or *mp4* after the link to override the audio/video format (default: video).

⚠️ File size limit is *200MB* (above ~90MB it is sent as a document). Default resolution is 720p; you can request *1080p* / *1440p* / *2160p* (4K), e.g. \`!dl <link> 1080p\`.

Want it sent as a *document* (full quality, no preview) or a regular *video*? Add *doc* or *video* at the end, e.g. \`!dl <link> 1080p doc\`. Default: regular video, automatically a document if the file is over ~90MB.`,

  "cmd.dlt": `🧵 *!dlt <link>*

Download a whole *thread* at once: all the post texts are combined in order (sent as text messages), then every photo/video is sent one by one. Works for X/Twitter threads, Threads (threads.net), and other sites supported by gallery-dl.

Same as *!dl <link> thread*. Threads links (threads.net/threads.com) are automatically treated as threads when you use plain *!dl*.

*Examples:*
\`\`\`
!dlt https://x.com/user/status/xxxxxxxxxxx
!dlt https://www.threads.net/@user/post/xxxxxxxxxxx
!dl https://x.com/user/status/xxxxxxxxxxx thread
\`\`\`

⚠️ Max *20 media* per thread, *95MB* limit per file. X/Twitter threads sometimes need cookies on the server (GALLERYDL_COOKIES_FILE).`,

  "cmd.dlr": `📷 *!dlr <link>*

Download *photo/carousel* posts only -- Instagram carousels (multiple swipeable photos) or TikTok photo+music/slideshow mode. All photos are sent one by one in their original order, then the music (if any) at the end.

Different from *!dl*: it goes straight to the photo route without trying video first -- faster if you already know the link is a carousel/photo slideshow (for regular videos/reels, keep using *!dl*).

*Examples:*
\`\`\`
!dlr https://www.instagram.com/p/xxxxxxxxxxx
!dlr https://www.tiktok.com/@user/video/xxxxxxxxxxx
\`\`\`

⚠️ File size limit is *95MB* per photo. Facebook posts that contain only PHOTOS (not video) are not supported -- this is purely for Instagram/TikTok.`,

  "cmd.ringkas": `📄 *!summarize [extra instructions]*

Summarize the main points of a PDF document using AI (Groq). Long documents (100+ pages) are automatically read section by section first and then combined into one summary, so everything gets covered -- not just the beginning.

*How to use:*
• Send a PDF file with the caption \`!summarize\`.
• Or send the PDF first, then *reply* with \`!summarize\`.
• You can add instructions after it, e.g. \`!summarize focus on the conclusion only\`.

*Examples:*
\`\`\`
!summarize
!summarize just explain the main points
\`\`\`

💡 After summarizing, you can ask more detailed questions about the document through normal chat (tag @AgemasenBot / reply to a bot message) for the next few hours -- the bot still "remembers" the full document, not just the summary.

⚠️ Only reads text that EXISTS in the PDF (scanned/photo PDFs without a text layer can't be read). Extremely long documents still have a hard limit, the rest is cut off.`,

  "cmd.artikel": `📚 *!article <keywords | DOI | URL>*

Search scholarly publications right from WhatsApp: title, authors, year, journal, DOI, citation count, and PDF links that are available *legally* (Open Access / arXiv).

*How to use:*
• *!article <keywords>* -> search publications (OpenAlex), then the DOI is matched via Crossref, a free PDF is checked via Unpaywall, and an arXiv version is looked up.
• *!article doi <DOI>* -> check metadata, citations, and PDF for a single DOI.
• *!article arxiv <keywords>* -> search preprints on arXiv.
• *!article <URL>* -> fetch a document from a public link (arXiv, DOAJ, Internet Archive, university repositories, OJS, or direct PDF links).

*Examples:*
\`\`\`
!article drone racing
!article doi 10.1000/xyz123
!article arxiv autonomous navigation
!article https://arxiv.org/abs/2101.00001
\`\`\`

💡 PDF status is split into *available*, *not found*, and *cannot be confirmed*. "Not found" does not guarantee there is no free version, and citation counts can differ between data providers.

⚠️ This bot INTENTIONALLY won't try to bypass paywalls, logins, CAPTCHAs, or DRM. Only links that are legally available are shown.`,

  "cmd.lupain": `🧠 *!forget*

Clear the AI chat memory between you and the bot -- including the PDF document memory from !summarize if there is one -- the bot will "forget" everything and start from scratch.

Image search commands (!img/!next/!id) are NOT affected, this only clears the AI chat memory.`,

  "cmd.lang": `🌐 *!lang [id|en]*

Switch the bot's language between *Bahasa Indonesia* and *English*.

*How to use:*
• *!lang* -> see the language currently in use.
• *!lang en* -> switch to English.
• *!lang id* -> switch to Bahasa Indonesia.

*Who does it apply to?*
• In a *DM*: the language is saved for your number only.
• In a *group*: the language is saved for the whole group, and only *group admins* (or the bot owner) can change it.

The setting is saved permanently, so it won't reset when the bot restarts.`,
  "cmd.trainer": "🏇 *!trainer <name or ID>*\n\nSearch Uma Musume trainers (uma.moe data). You get a list of trainers with similar names plus their IDs. *Reply* to that list with a number to see the trainer card (inheritance, factors, support card).\n\nIf you type a trainer ID (9-12 digits), the card is shown right away.\n\n*Example:*\n```\n!trainer azan\n!trainer 243028085654\n```",
  "cmd.club": "🏯 *!club <club name or ID>*\n\nSearch Uma Musume clubs (circles, uma.moe data). You get a list of clubs with similar names plus club ID and leader name. *Reply* to that list with a number to see the club card (stats, rank and each member\'s gain).\n\nIf you type a club ID (digits), the card is shown right away.\n\n*Example:*\n```\n!club hachimi\n!club 738117397\n```",
  "cmd.threshold": "📊 *!threshold*\n\nSends the Uma Musume circle rank threshold card from tier SS down to D (minimum fans, fans per day and deltas for each tier).\n\n*Example:*\n```\n!threshold\n```",
  "cmd.leaderboard": "🏆 *!leaderboard*\n\nSends the Uma Musume circle leaderboard card for rank 1 to 50 (tier, leader, live fans and monthly fans).\n\n*Example:*\n```\n!leaderboard\n!lb\n```",
  "cmd.analisis": "📈 *!analysis <coin> [1H|4H|1D]*\n\nCrypto technical analysis (price, indicators, support/resistance, bullish/bearish scenarios, news, risks) sent as a *PDF file*.\n\n*Examples:*\n```\n!analysis btc\n!analysis sol 4h\n!analysis eth 1d\n```\n\nDefault timeframe is *4H*. Use the coin ticker (BTC, ETH, SOL, etc).\n\n⚠️ Automated analysis for education only, not trading signals. Takes about 10-40 seconds, with a 30-second cooldown between requests.",
  "cmd.chart": "🕯️ *!chart <coin> [15m|1H|4H|1D]*\n\nSends a candlestick chart image with EMA 20/50/200 lines and dashed support/resistance lines.\n\n*Examples:*\n```\n!chart btc 1d\n!chart sol\n```\n\nDefault timeframe is *4H*.",
  "cmd.harga": "💰 *!price <coin>*\n\nLive price in USDT and Rupiah with the 24h percent change.\n\n*Example:*\n```\n!price eth\n```",
  "cmd.level": "📊 *!level <coin> [15m|1H|4H|1D]*\n\nResistance (R1, R2) and support (S1, S2) levels with the percent distance from the current price.\n\n*Example:*\n```\n!level sol 4h\n```\n\nDefault timeframe is *4H*. Not financial advice.",
  "cmd.listkripto": "📋 *!listcrypto [keyword]*\n\nCoins available for !price, !chart, !level, and !analysis, grouped by category.\n\n*Examples:*\n```\n!listcrypto\n!listcrypto meme\n!listcrypto sol\n```\n\nOptional keyword: category, ticker, or coin name.",
  "cmd.ema": "📐 *!ema <coin> [15m|1H|4H|1D]*\n\nEMA 20, 50, 200 values and where the price sits against each one (above / below).\n\n*Example:*\n```\n!ema bnb 4h\n```\n\nDefault timeframe is *4H*. Not financial advice.",
  "cmd.tren": "🧭 *!trend <coin> [15m|1H|4H|1D]*\n\nTrend status: bullish, bearish, or sideways. Mentions a golden cross / death cross if one just happened.\n\n*Example:*\n```\n!trend xrp 4h\n```\n\nDefault timeframe is *4H*. Not financial advice.",
  "cmd.mtf": "🗂️ *!mtf <coin>*\n\nMulti-timeframe summary (15m, 1H, 4H, 1D) in one table so you can see how the trends line up.\n\n*Example:*\n```\n!mtf btc\n```\n\nColumns: timeframe, trend, position vs EMA 200, nearest level. Not financial advice.",
  "cmd.bandingkan": "⚔️ *!compare <coin1> <coin2>*\n\nCompares two coins side by side: price, % change, trend, and position against the EMAs, with a short verdict on which one is stronger.\n\n*Example:*\n```\n!compare sol eth\n```\n\nUses your default timeframe (initially *4H*). Not financial advice.",
  "cmd.semua": "📊 *!all [category] [15m|1H|4H|1D]*\n\nList of all coins with price and % change. Results are paginated (25 coins per page), type *!next* for the next page.\n\n*Examples:*\n```\n!all\n!all layer1\n!all meme 1h\n```\n\n% change follows the timeframe (your default, initially *4H*). Category is optional, see the list with *!categories*. Not financial advice.",
  "cmd.top": "🚀 *!top [count]*\n\nTop 24h gainers: coins that rose the most.\n\n*Examples:*\n```\n!top\n!top 5\n```\n\nDefault 10 coins, max 25. Not financial advice.",
  "cmd.flop": "📉 *!flop [count]*\n\nTop 24h losers: coins that fell the most.\n\n*Examples:*\n```\n!flop\n!flop 5\n```\n\nDefault 10 coins, max 25. Not financial advice.",
  "cmd.kategori": "🗂️ *!categories*\n\nShows the coin categories and how many coins each has. The filter word can be used with *!all*.\n\n*Example:*\n```\n!categories\n```",
  "cmd.cari": "🔍 *!search <name>*\n\nSearch coins by name or ticker (partial match).\n\n*Examples:*\n```\n!search sol\n!search bit\n```\n\nResults show ticker and coin name. Check the price with *!price <ticker>*.",
};
