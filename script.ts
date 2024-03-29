import cheerio from 'https://esm.sh/cheerio@1.0.0-rc.12'; //'npm:cheerio@1.0.0-rc.12';
import csvToJson from 'https://esm.sh/csvjson';
import type { LetterboxdFilm, LetterboxdList, Film, LetterboxdListFile } from './src/app.d.ts';

console.time('finished after');
const startTime = new Date();
const fileName = './src/letterboxdLists.json';
const numberOfConcurrentFetches = 5;

const lists = Deno.readTextFileSync('letterboxdUrls.txt')
	.split('\n')
	.filter((x) => x)
	.map((x) => ({ url: x.split('|')[1].trim(), name: x.split('|')[0].trim() }));

// const filledLists = await Promise.all(lists.map((x) => createEntry(x.name, x.url)));

const infoCache = new Map<string, Film>();

const listFiles = [] as LetterboxdListFile[];
// const filledLists = [] as LetterboxdList[];
for (const list of lists) {
	const nameUrl = encodeURIComponent(list.name.replace(/[^a-zA-Z0-9 ]/g, '').replaceAll(' ', '_'));
	const filePath = `lists/${nameUrl}.json`;
	const listObj = await createEntry(list.name, list.url);
	Deno.writeTextFileSync('static/' + filePath, JSON.stringify(listObj, null, 2));
	listFiles.push({ name: list.name, filePath, nameUrl });
	console.log(`file for '${list.name}' is ${await fileSize('static/' + filePath)}`);
}

Deno.writeTextFileSync(fileName, JSON.stringify(listFiles, null, 2));
console.log('\nfinished after ' + timeTillNow(startTime));

/// functions
///

async function createEntry(listName: string, url: string) {
	const films: Film[] = url.includes('imdb.com/')
		? await processImdbList(listName, url)
		: await processLetterboxdList(listName, url);

	let streamProviders = [] as string[];
	films.forEach((x) => {
		streamProviders = [...new Set([...streamProviders, ...x.streamProviders])];
	});
	streamProviders.sort();

	return {
		name: listName,
		url,
		description: await fetchListDescription(url),
		entries: films,
		streamProviders: streamProviders.map((x) => ({ name: x, enabled: false }))
	} as LetterboxdList;
}
async function processImdbList(listName: string, url: string) {
	const csv = (await (await fetch(url)).text()) as string;
	const json = csvToJson.toObject(csv, { delimiter: ',', quote: '"' }) as ImdbEntry[];

	const entries = json
		.filter((x) => ['tvMiniSeries', 'tvSeries', 'short', 'video'].includes(x['Title Type']))
		.map((x) => ({
			name: x.Title,
			originalTitle: x.Title,
			year: x.Year === '' ? undefined : parseInt(x.Year as string) + '',
			rating: x['IMDb Rating'] === '' ? undefined : parseFloat(x['IMDb Rating'] as string),
			listPosition: x.Position,
			numberOfEpisodes: undefined,
			letterboxdUrl: x.URL,
			type: x['Title Type']
		}));

	const results = [] as Film[];
	let cursor = 0;
	while (cursor < entries.length) {
		const chunk = entries.slice(cursor, cursor + numberOfConcurrentFetches);
		const chunkResults = await Promise.all(chunk.map((x) => getFilmStreamInfo(x)));
		console.log(chunkResults);
		results.push(...chunkResults);
		cursor += numberOfConcurrentFetches;
	}

	return results;
	interface ImdbEntry {
		Position: number;
		Const: string;
		Created: Date;
		Modified: Date;
		Description: string;
		Title: string;
		URL: string;
		'Title Type': 'movie' | 'short' | 'tvEpisode' | 'tvMiniSeries' | 'tvMovie' | 'tvSeries' | 'video' | 'videoGame';
		'IMDb Rating': number | string;
		'Runtime (mins)': number | string;
		Year: number | string;
		Genres: string;
		'Num Votes': number | string;
		'Release Date': string;
		Directors: string;
		'Your Rating': number | string;
		'Date Rated': string;
	}
}

async function processLetterboxdList(listName: string, url: string) {
	const firstPage = 1;
	let currentPage = firstPage;
	let lastPage = 9999; // will be overriden

	const films: Film[] = [];
	while (currentPage <= lastPage) {
		console.log(`fetching page ${currentPage}`);
		console.time('page');
		try {
			const fetches = [];
			for (let i = 0; i < numberOfConcurrentFetches; i++) {
				fetches.push(fetchPageFromLetterboxd(url, currentPage + i));
			}
			const contents = await Promise.all(fetches);
			const cheerioContents = contents.map((x) => cheerio.load(x));

			for (const $ of cheerioContents) {
				if ($('.linked-film-poster img').length === 0) currentPage = lastPage;

				const letterboxdFilms: LetterboxdFilm[] = [];
				$('.poster-container').each((_, el) => {
					const name = $(el).find('img').attr('alt')!;
					const letterboxdUrl = 'https://letterboxd.com/film/' + $(el).find('[data-film-slug]').attr('data-film-slug')!;
					const listPosition = Number($(el).find('.list-number').text());
					console.log({ name, listPosition });
					letterboxdFilms.push({ name, letterboxdUrl, listPosition });
				});

				const filmsWithInfo = await Promise.all(letterboxdFilms.map((x) => getFilmInfo(x)));
				filmsWithInfo.forEach((x) => films.push(x));

				// for (let index = 0; index < letterboxdFilms.length; index++) {
				// 	consoleLogSameLine(`\n${time()} item ${index + 1} of ${letterboxdFilms.length}.`);
				// 	films.push(await getFilmInfo(letterboxdFilms[index]));
				// }

				// for (const film of letterboxdFilms) {
				// 	films.push(await getFilmInfo(film));
				// }

				// const getFilmInfoPromises = letterboxdFilms.map((film) => getFilmInfo(film));
				// const chunkSize = Math.ceil(getFilmInfoPromises.length / 2);
				// const filmsChunks = chunk(getFilmInfoPromises, chunkSize);
				// for (const filmsChunk of filmsChunks) {
				// 	await Promise.all(filmsChunk);
				// }
			}

			currentPage += numberOfConcurrentFetches;
		} catch (err) {
			console.log('problem fetching for page ' + currentPage + '. Trying again...', err);
			continue;
		}
		console.timeEnd('page');
	}
	return films;
}

async function fetchListDescription(listUrl: string) {
	const page = await fetch(listUrl, {}).then((x) => x.text());
	const $ = cheerio.load(page);
	return $('.list-title-intro .body-text').toString();
}

async function fetchPageFromLetterboxd(listUrl: string, currentPage: number) {
	return await fetch(listUrl + `page/${currentPage}`, { timeout: 10 * 1000 }).then((x) => x.text());
}

async function getFilmInfo(movie: LetterboxdFilm, retries = 0) {
	if (infoCache.has(movie.letterboxdUrl)) {
		consoleLogSameLine('  cache hit\n');
		return { ...infoCache.get(movie.letterboxdUrl), listPosition: movie.listPosition };
	}
	try {
		// consoleLogSameLine('  info.. \n');
		const html = await fetchWithTimeout(movie.letterboxdUrl, { timeout: 10 * 1000 }).then((x) => x.text());
		const $ = cheerio.load(html);
		const found = $('#featured-film-header h1').text() ? true : false;
		if (!found) throw new Error('film not found in letterboxd' + movie.name);
		const year = $('#featured-film-header .number').text();
		const originalTitle = $('#featured-film-header em').text().replace('‘', '').replace('’', '') || movie.name;
		const rating = Number(Number($('[name="twitter:data2"]').attr('content')?.split(' ')?.[0] || '0').toFixed(1));
		const imageUrl =
			html.match(/"image":"https:\/\/a\.ltrbxd\.com\/resized\/.+?(?=")/)?.[0].replace(`"image":"`, ``) ?? '';

		const filmWithInfo = await getFilmStreamInfo({ ...movie, year, originalTitle, rating, imageUrl });
		infoCache.set(movie.letterboxdUrl, filmWithInfo);
		return filmWithInfo;
	} catch (error) {
		if (retries > 9) {
			console.error('too many retries, aborting to not fall into infinity loop: ' + movie.name);
			return movie;
		}
		console.error('error in getFilmInfo for ' + movie.letterboxdUrl + '. trying again...', error?.message);
		await sleep(1000);
		return await getFilmInfo(movie, retries++);
	}
}

async function getFilmStreamInfo(movie: LetterboxdFilm, retries = 0) {
	// consoleLogSameLine(' streamInfo.. ');
	try {
		const res = await fetchWithTimeout(
			`https://www.werstreamt.es/filme/?q=${encodeURIComponent(movie.originalTitle)}`
		).then((x) => x.text());
		let $ = cheerio.load(res);

		if (res.length < 200) throw new Error(res);

		const firstMovie = $('[itemprop="itemListElement"]')
			.filter((_, el) => $(el).find('[itemprop="dateCreated"]').attr('content')?.includes(movie.year))
			.first();

		if (!movie.imageUrl) {
			movie.imageUrl = firstMovie.find('.poster img').attr('src'); // letterboxd fills this
		}

		const movieUrl = 'https://www.werstreamt.es/' + firstMovie.find('[itemprop="url"]').attr('href');

		if (!movieUrl) {
			return { ...movie, streamProviders: [], imageUrl: '' };
		}

		const res2 = await fetchWithTimeout(movieUrl).then((x) => x.text());
		$ = cheerio.load(res2);

		const streamProvidersOriginalTitle = $('.ContentSummary [itemprop=alternateName]').text().trim();
		const streamProviders = $('.provider')
			.filter((_, el) => {
				return $(el).find('small:contains("Flatrate")').parent().find('.fi-check').length > 0;
			})
			.map((_, el) => {
				const company = $(el).find('h5 .grouptitle').text().trim().trim();
				const service = $(el).find('h5 a').text().replace(company, '').trim().trim();
				if (company && service) return `${company} ${service}`;
				if (company) return `${company}`;
				if (service) return `${service}`;
			})
			.get();

		return { ...movie, streamProviders, streamProvidersOriginalTitle } as Film;
	} catch (error) {
		if (retries > 9) {
			console.error('too many retries, aborting to not fall into infinity loop: ' + movie.name);
			return movie;
		}
		console.error(`${time()}` + '  error in getFilmStreamInfo for ' + movie.name + '. trying again...', error?.message);
		await sleep(3000);
		return await getFilmStreamInfo(movie, retries++);
	}
}

function consoleLogSameLine(msg: string) {
	return Deno.writeAllSync(Deno.stdout, new TextEncoder().encode(msg));
}

function timeTillNow(date: Date) {
	const remaining = new Date().getTime() - date.getTime();
	const remainingS = remaining / 1000;
	const remainingM = remainingS / 60;
	const remainingH = remainingM / 60;
	if (remainingS < 1) return `${remaining.toFixed(2)}ms`;
	if (remainingM < 1) return `${remainingS.toFixed(2)}s`;
	if (remainingH < 1) return `${remainingM.toFixed(2)}min`;
	return `${remainingM.toFixed(2)}h`;
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fileSize(path: string) {
	return `${((await Deno.stat(path)).size / 1024 / 1024).toFixed(2)}mb`;
}

async function fetchWithTimeout(resource: string, options = {}) {
	const { timeout = 8000 } = options;

	const controller = new AbortController();
	const id = setTimeout(() => controller.abort(), timeout);
	const response = await fetch(resource, {
		...options,
		signal: controller.signal
	});
	clearTimeout(id);
	return response;
}

function time() {
	return new Date().toTimeString().split(' ')[0];
}
