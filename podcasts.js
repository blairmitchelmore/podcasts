var http = require("http");
var https = require("https");
var xpath = require('xpath');
var dom = require('xmldom').DOMParser;
var fs = require("fs");
var path = require("path");
var mkdirp = require('mkdirp');
var url = require('url');
var prettysize = require('prettysize');
var sanitize = require('sanitize-filename');
var CommandRouter = require('command-router');
var cli = CommandRouter();

cli.option({ name: 'config', alias: 'c', default: "./config.json", type: String });
cli.option({ name: 'concurrent', default: 3, type: Number });

var ProcessState = function(p) {
	this.text = "";
	this.printing = p;
};

ProcessState.prototype.log = function log(msg) {
	if (this.printing) console.log(msg);
};

var PodcastState = function(p, c, r) {
	var podcast = p;
	var children = c || [];
	var refreshing = r;
	
	Object.defineProperty(this, 'podcast', {
		get: function() {
			return podcast ? Object.freeze(podcast) : null;
		}
	});
	Object.defineProperty(this, 'children', {
		get: function() {
			return Object.freeze(children);
		}
	});
	Object.defineProperty(this, 'refreshing', {
		get: function() {
			return refreshing;
		}
	});
};

PodcastState.prototype.print = function print() {
	if (!this.refreshing) return;
	if (this.finished) return;
	var children = this.children;
	var width = process.stdout.columns;
	if (this.clear_screen) {
		var blank = new Array(width).join(" ");
		var O33 = "\033";
		var reset = `${O33}[${children.length}A${O33}[${width}D`;
		console.log(reset);
		console.log("\033[2A");
	} else {
		this.clear_screen = true;
	}
	children.forEach(function(state) {
		var text = state.text || "";
		var substring = text.substring(0, width - 4);
		console.log((substring == state.text ? state.text : substring + "...") + "\033[K");
	});
};

PodcastState.prototype.start = function start() {
	console.log(`Updating ${this.podcast.name}`);
	if (this.refreshing) this.interval = setInterval(() => this.print(), 50);
};

PodcastState.prototype.finish = function finish(size) {
	if (this.interval) clearInterval(this.interval);
	this.print();
	this.finished = true;
	console.log(`Total size: ${prettysize(size)}`);
	console.log("Done");
};

var splay = function splay(fn) {
	return function(first) {
		fn.apply(this, first);
	};
};

var make_list = function make_list(size) {
	var list = [];
	var index = 0;
	while (index < size) {
		list.push(index);
		index++;
	}
	return list;
};

var empty_config = function() {
	return {
		podcasts: []
	};
};

var empty_etags = function() {
	return {};
};

var load_config = function(location) {
	return new Promise(function(resolve, reject) {
		fs.readFile(location, function(err, buffer) {
			if (err && err.code === 'ENOENT') resolve(empty_config());
			else if (err) reject(err);
			else resolve(JSON.parse(buffer.toString()));
		});
	});
};

var save_config = function(location, config) {
	return new Promise(function(resolve, reject) {
		fs.writeFile(location, JSON.stringify(config, null, "\t"), function(err, buffer) {
			if (err) reject(err);
			else resolve(config);
		});
	});
};

var filter_podcasts = function(podcasts, filter) {
	return podcasts.filter(function(podcast) {
		if (filter) {
			if (Array.isArray(filter)) {
				return !!filter.filter(function(active) {
					return active === podcast.name;
				}).length;
			} else {
				return podcast.name === filter;
			}
		} else {
			return true;
		}
	}).map(function(podcast) {
		var name = podcast.name;
		var url = podcast.url;
		var etags = `./_etags/${name}.etags.json`;
		var downloads = `./downloads/${name}`;
		podcast.etags = path.resolve(podcast.etags || etags);
		podcast.downloads = path.resolve(podcast.downloads || downloads);
		podcast.concurrent = podcast.concurrent || cli.options.concurrent;
		return podcast;
	});
};

var load_etags = function load_etags(podcast) {
	return new Promise(function(resolve, reject) {
		fs.readFile(podcast.etags, function(err, buffer) {
			if (err && err.code === 'ENOENT') resolve(empty_etags());
			else if (err) reject(err);
			else resolve(buffer ? JSON.parse(buffer.toString()) : {});
		});
	});
};

var save_etags = function save_etags(podcast, etags, updates) {
	return new Promise(function(resolve, reject) {
		var dict = (updates || []).reduce(function(dict, item) { 
			if (item.etag) dict[item.url] = item.etag;
			else delete dict[item.url];
			return dict;
		}, etags);
		var string = JSON.stringify(dict, null, "\t");
		fs.writeFile(podcast.etags, string, function(err) {
			if (err) reject(err);
			else resolve(true);
		});
	});
};

var prepare_downloads = function prepare_downloads(podcast) {
	return new Promise(function(resolve, reject) {
		mkdirp(path.resolve(podcast.downloads), function(err) {
			if (err) reject(err);
			else resolve(true);
		});
	});
};

var clean_xml = function clean_xml(xml) {
	return xml.replace(/(&|&amp;)nbsp;/g, " ");
};

var process_podcast_xml = function process_podcast_xml(xml) {
	var clean = clean_xml(xml);
	var doc = new dom().parseFromString(clean);
 	var nodes = xpath.select("//item[enclosure/@url]", doc);
	var items = nodes.map(function(node) {
		var title = xpath.select("./title/text()", node).toString();
		var url = xpath.select("./enclosure/@url", node)[0].value;
		return { title: title, url: url };
	});
	return items;
};

var request_feed = function request_feed(url) {
	return new Promise(function(resolve, reject) {
		var HTTP = (url.protocol == "https:") ? https : http;
		HTTP.request(url, function(response) {
			var str = '';

			response.on('data', function(chunk) {
				str += chunk;
			});
			
			response.on('error', function(err) {
				reject(err);
			});

			response.on('end', function() {
				resolve(str);
			});
		}).end();
	});
};

var load_podcast = function load_podcast(podcast) {
	return new Promise(function(resolve, reject) {
		request_feed(podcast.url).then(function(result) {
			resolve(process_podcast_xml(result));
		}).catch(reject);
	});
};

var transform_episode_list = function transform_episode_list(episodes, etags) {
	return [].concat.apply([], episodes).map(function(item, index, array) {
		item.index = array.length - index;
		item.etag = etags[item.url];
		item.src = item.url;
		return item;
	});
};

var clean_string = function clean_string(string) {
	return sanitize(string.split(path.sep).join('–').split(/[/\\]/g).join('-').replace("&amp;", "and").replace("&nbsp;", " "));
};

var src_ext = function src_ext(src) {
	return path.extname(src).split('?').shift();
};

var download_destination = function download_destination(podcast, item) {
	var dir = podcast.downloads;
	var name = clean_string(`[${item.index}] ${item.title}`);
	var ext = src_ext(item.src);
	var base = [name, ext].join('');
	var options = { dir: dir, name: name, ext: ext, base: base };
	var formatted = path.format(options);
	return formatted;
};

var download_remote_item = function download_remote_item(item, state) {
	return new Promise(function(resolve, reject) {
		var file = fs.createWriteStream(item.dest);
		file.on('open', function(fd) {
			var request = http.get(item.src, function(response) {
				var statusCode = response.statusCode;
				var total = parseInt(response.headers['content-length'], 10);
				var current = 0;
				var percent = 0;
				var size = 0;
				var etag = response.headers.etag;
				
				if (statusCode == 301 || statusCode == 302) {
					item.src = response.headers.location;
					file.end();
					resolve(download_remote_item(item, state));
				} else if (statusCode >= 400) { 
					var err = new Error("Error downloading file");
					reject(err);
				} else {
					response.on('data', function(chunk) {
						file.write(chunk)
						size += chunk.length;
						current += chunk.length;
						percent = Math.floor(100 * current / total);
						state.text = `Downloading ${item.title} ${percent}%`;
					}).on('error', function(err) {
						file.end();
						reject(err);
					}).on('end', function() {
						file.end();
						item.size = size;
						item.etag = etag;
						state.log(`Saving etag ${etag} for ${item.title}`);
						resolve(item);
					});
				}
			});
			request.on("error", function(err) {
				reject(err);
			});
		});
		file.on("error", function(err) {
			reject(err);
		});
	});
};

var verify_local_item = function verify_local_item(item, stats, state) {
	return new Promise(function(resolve, reject) {
		var args = arguments;
		var options = url.parse(item.src);
		options.method = 'HEAD';
		var request = http.get(options, function(response) {
			var statusCode = response.statusCode;
			state.log(`Found response with status ${statusCode}`);
			state.log(`Validating etag ${item.etag} against ${response.headers.etag}`);
			if (statusCode == 301 || statusCode == 302) {
				item.src = response.headers.location;
				resolve(verify_local_item(item, stats, state));
			} else if (statusCode >= 400) { 
				var err = new Error("Error checking file")
				reject(err);
			} else if (item.etag == response.headers.etag) { 
				state.text = `Cached ${item.title}`;
				state.log(state.text);
				item.size = stats.size;
				resolve(item);
			} else {
				state.text = `Loading ${item.title}`;
				state.log(state.text);
				resolve(download_remote_item(item, state));
			}
		});
		request.on("error", function(err) {
			reject(err);
		});
	});
};

var refresh_item = function refresh_item(podcast, item, state) {
	return new Promise(function(resolve, reject) {
		item.dest = download_destination(podcast, item);
		fs.stat(item.dest, function(err, stats) {
			if (err) {
				resolve(download_remote_item(item, state));
			} else {
				resolve(verify_local_item(item, stats, state));
			}
		});
	});
};

var process_items = function process_items(podcast, items, etags, processed, state) {
	return new Promise(function(resolve, reject) {
		var results = [];
		var action = function action(item) {
			var cont = function() {
				var next = items.pop();
				if (next) action(next);
				else resolve(results);
			};
			state.text = `Starting ${item.title}`;
			refresh_item(podcast, item, state).then(function(result) {
				state.text = `Finished ${item.title}`;
				results.push(result);
				processed.push(result);
				save_etags(podcast, etags, processed).then(cont);
			}).catch(function(err) {
				state.text = `Error ${item.title}: ${err}`;
				cont();
			});
		};
		action(items.pop());
	});
};

var observe_processes = function observe_processes(podcast, processes, etags, state) {
	return new Promise(function(resolve, reject) {
		state.start();
		Promise.all(processes).then(function(results) {
			var items = results.reduce((array, add) => array.concat(add), []);
			var size = items.reduce((sum, item) => sum + item.size, 0);
			save_etags(podcast, etags, items).then(function() {
				state.finish(size);
				resolve();
			});
		});
	});
};

var process_podcast = function process_podcast(podcast, episodes, etags) {
	return new Promise(function(resolve, reject) {
		var processed = [];
		var items = transform_episode_list(episodes, etags);
		var states = make_list(podcast.concurrent).map(i => new ProcessState(cli.options.verbose));
		var state = new PodcastState(podcast, states, !cli.options.verbose);
		var processes = state.children.map(state => process_items(podcast, items, etags, processed, state));
		resolve(observe_processes(podcast, processes, etags, state));
	});
};

var refresh_podcast = function refresh_podcast(podcast) {
	return new Promise(function(resolve, reject) {
		Promise.all([load_etags(podcast), prepare_downloads(podcast), load_podcast(podcast)]).then(splay(function(etags, prepared, episodes) {
			resolve(process_podcast(podcast, episodes, etags));
		})).catch(reject);
	});
};

var refresh_podcasts = function refresh_podcasts(podcasts) {
	return new Promise(function(resolve, reject) {
		var results = [];
		var action = function action(podcast) {
			var cont = function() {
				var next = podcasts.pop();
				if (next) action(next);
				else resolve(results);
			};
			refresh_podcast(podcast).then(function(result) {
				results.push(result);
				cont();
			}).catch(function(err) {
				cont();
			});
		};
		action(podcasts.pop());
	});
};

var refresh = function refresh(filter) {
	load_config(path.resolve(cli.options.config)).then(function(config) {
		var podcasts = filter_podcasts(config.podcasts, filter);
		return refresh_podcasts(podcasts);
	});
};

var find_podcast = function find_podcast(name) {
	return new Promise(function(resolve, reject) {
		load_config(path.resolve(cli.options.config)).then(function(config) {
			var podcasts = filter_podcasts(config.podcasts, name);
			if (podcasts.length) resolve(podcasts.pop());
			else resolve(null);
		});
	});
};

var list_podcasts = function list_podcasts() {
	return new Promise(function(resolve, reject) {
		load_config(path.resolve(cli.options.config)).then(function(config) {
			var names = config.podcasts.forEach(function(podcast) {
				console.log(`${podcast.name}`);
			});
		});
	});
};

var update_podcast = function update_podcast(name, url) {
	var loc = path.resolve(cli.options.config);
	return find_podcast(name).then(function(podcast) {
		if (podcast) {
			return load_config(loc);
		} else {
			console.log(`No such podcast ${name} found`);
		}
	}).then(function(config) {
		config.podcasts = config.podcasts.map(function(podcast) {
			if (podcast.name == name) podcast.url = url;
			return podcast;
		});
		return save_config(loc, config);
	}).then(function(config) {
		return find_podcast(name);
	}).catch(function(err) {
		console.log(`There was a problem updating the podcast: ${err}`);
	});;
};

var add_podcast = function add_podcast(name, url) {
	var loc = path.resolve(cli.options.config);
	return find_podcast(name).then(function(podcast) {
		if (podcast) {
			console.log(`Podcast ${name} already exists`);
		} else {
			return load_config(loc);
		}
	}).then(function(config) {
		config.podcasts.push({ name: name, url: url });
		config.podcasts.sort(function(a, b) {
			return a.name.localeCompare(b.name);
		});
		return save_config(loc, config);
	}).then(function(config) {
		return find_podcast(name);
	}).catch(function(err) {
		console.log(`There was a problem adding the podcast: ${err}`);
	});
};

cli.command('add :name *', function() {
	var name = cli.params.name;
	var url = cli.params.splats.shift();
	add_podcast(name, url).then(refresh_podcast);
});

cli.command('update :name *', function() {
	var name = cli.params.name;
	var url = cli.params.splats.shift();
	update_podcast(name, url).then(refresh_podcast);
});

cli.command('refresh :podcast', function() {
	var podcasts = cli.params.podcast.replace(/$\s+/g, "").replace(/\s+^/g, "").split(/\s+/g);
	refresh(podcasts);
});

cli.command('refresh', function() {
	refresh();
});

cli.command('', function() {
	list_podcasts();
});

cli.parse(process.argv);
