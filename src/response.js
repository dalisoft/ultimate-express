const cookie = require("cookie");
const mime = require("mime-types");
const vary = require("vary");
const { normalizeType, stringify, deprecated } = require("./utils.js");
const { Writable } = require("stream");
const { isAbsolute } = require("path");
const fs = require("fs");
const Path = require("path");
const { Worker } = require("worker_threads");
const statuses = require("statuses");
const { sign } = require("cookie-signature");
const { EventEmitter } = require("tseep");
const http = require("http");
const os = require('os');

const outgoingMessage = new http.OutgoingMessage();
const symbols = Object.getOwnPropertySymbols(outgoingMessage);
const kOutHeaders = symbols.find(s => s.toString() === 'Symbol(kOutHeaders)');

const cpuCount = os.cpus().length;

let fsWorker;
let fsKey = 0;
const fsCache = {};
// only create fs worker if cpuCount is greater than 1
// otherwise it's not worth it
if(cpuCount > 1) {
    fsWorker = new Worker(Path.join(__dirname, 'workers/fs.js'));

    fsWorker.on('message', (message) => {
        if(message.err) {
            fsCache[message.key].reject(new Error(message.err));
        } else {
            fsCache[message.key].resolve(message.data);
        }
        delete fsCache[message.key];
    });
    fsWorker.unref();
}

function readFile(path) {
    return new Promise((resolve, reject) => {
        if(!fsWorker) {
            return reject(new Error('fsWorker is not available'));
        }
        const key = fsKey++;
        fsWorker.postMessage({ key, type: 'readFile', path });
        fsCache[key] = { resolve, reject };
        if(key > 1000000) {
            fsKey = 0;
        }
    });
}

class Socket extends EventEmitter {
    constructor(response) {
        super();
        this.response = response;
        this.writable = true;

        this.on('error', (err) => {
            this.emit('close');
        });
        this.on('close', () => {
            this.writable = false;
        });
    }
}

module.exports = class Response extends Writable {
    constructor(res, req, app) {
        super();
        this._req = req;
        this._res = res;
        this.headersSent = false;
        this.aborted = false;
        this.socket = new Socket(this);
        this.app = app;
        this.locals = {};
        this.aborted = false;
        this.statusCode = 200;
        this.headers = {
            'keep-alive': 'timeout=10'
        };
        // support for node internal
        this[kOutHeaders] = new Proxy(this.headers, {
            set: (obj, prop, value) => {
                this.set(prop, value[1]);
                return true;
            },
            get: (obj, prop) => {
                return obj[prop];
            }
        });
        this.body = undefined;
        if(this.app.get('x-powered-by')) {
            this.set('x-powered-by', 'uExpress');
        }
        this.on('error', (err) => {
            if(this.aborted) {
                return;
            }
            this._res.cork(() => {
                this._res.close();
                this.socket.emit('close');
            });
        });
        this.emit('socket', this.socket);
    }
    _write(chunk, encoding, callback) {
        if(this.aborted) {
            const err = new Error('Request aborted');
            err.code = 'ECONNABORTED';
            return this.destroy(err);
        }
        if(!Buffer.isBuffer(chunk)) {
            chunk = Buffer.from(chunk);
        }
        this._res.cork(() => {
            if(!this.headersSent) {
                this.writeHead(this.statusCode);
                this._res.writeStatus(this.statusCode.toString());
                for(const header in this.headers) {
                    if(header === 'content-length') {
                        continue;
                    }
                    this._res.writeHeader(header, this.headers[header]);
                }
                if(!this.headers['content-type']) {
                    this._res.writeHeader('content-type', 'text/html');
                }
                this.headersSent = true;
            }
            const ab = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
            this._res.write(ab);
            callback();
        });
    }
    writeHead(statusCode, statusMessage, headers) {
        this.statusCode = statusCode;
        if(!headers) {
            if(!statusMessage) return;
            headers = statusMessage;
        }
        for(let header in headers) {
            this.set(header, headers[header]);
        }
    }
    _implicitHeader() {
        // compatibility function
        // usually should send headers but this is useless for us
        return;
    }
    status(code) {
        if(this.headersSent) {
            throw new Error('Can\'t set status: Response was already sent');
        }
        this.statusCode = parseInt(code);
        return this;
    }
    sendStatus(code) {
        return this.status(code).send(statuses.message[+code] ?? code.toString());
    }
    end(data) {
        if(this.finished) {
            return;
        }
        
        this._res.cork(() => {
            if(!this.headersSent) {
                if(this.req.fresh) {
                    if(!this.headersSent) {
                        this._res.writeStatus('304');
                    }
                    this.headersSent = true;
                    this.socket.emit('close');
                    return this._res.end();
                }
                this._res.writeStatus(this.statusCode.toString());
                for(const header in this.headers) {
                    if(header === 'content-length') {
                        continue;
                    }
                    this._res.writeHeader(header, this.headers[header]);
                }
                if(!this.headers['content-type']) {
                    this._res.writeHeader('content-type', 'text/html');
                }
                this.headersSent = true;
            }
            this._res.end(data);
            this.socket.emit('close');
        });

        return this;
    }
    send(body) {
        if(this.headersSent) {
            throw new Error('Can\'t write body: Response was already sent');
        }
        if(Buffer.isBuffer(body)) {
            body = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
        } else if(body === null || body === undefined) {
            body = '';
        } else if(typeof body === 'object') {
            if(!(body instanceof ArrayBuffer)) {
                body = stringify(body);
            }
        } else if(typeof body === 'number') {
            if(arguments[1]) {
                deprecated('res.send(status, body)', 'res.status(status).send(body)');
                return this.status(body).send(arguments[1]);
            } else {
                deprecated('res.send(status)', 'res.sendStatus(status)');
                return this.sendStatus(body);
            }
        } else {
            body = String(body);
        }
        this.writeHead(this.statusCode);
        return this.end(body);
    }
    sendFile(path, options = {}, callback) {
        // TODO: support options
        // TODO: support Range
        if(!path) {
            throw new TypeError('path argument is required to res.sendFile');
        }
        if(typeof path !== 'string') {
            throw new TypeError('path argument is required to res.sendFile');
        }
        if(typeof options === 'function') {
            callback = options;
            options = {};
        }
        if(!options) options = {};
        if(!options.root && !isAbsolute(path)) {
            throw new TypeError('path must be absolute or specify root to res.sendFile');
        }
        const fullpath = options.root ? Path.resolve(Path.join(options.root, path)) : path;
        if(options.root && !fullpath.startsWith(Path.resolve(options.root))) {
            throw new Error('Forbidden');
        }
        const stat = fs.statSync(fullpath);
        if(stat.isDirectory()) {
            return this.status(404).send(this.app._generateErrorPage(`Cannot ${this.req.method} ${this.req.path}`));
        }

        if(!this.get('Content-Type')) {
            this.type(mime.lookup(fullpath));
        }

        //there's no point in creating a stream when the file is small enough to fit in a single chunk
        if(stat.size < 64 * 1024 && fsWorker) { // 64kb - default highWaterMark
            // get file using worker
            readFile(fullpath).then((data) => {
                if(this._res.aborted) {
                    return;
                }
                this.send(data);
                if(callback) callback();
            }).catch((err) => {
                if(callback) callback(err);
            });
        } else {
            const file = fs.createReadStream(fullpath);
            pipeStreamOverResponse(this, file, stat.size, callback);
        }
    }
    download(path, filename, options, callback) {
        let done = callback;
        let name = filename;
        let opts = options || {};

        // support function as second or third arg
        if (typeof filename === 'function') {
            done = filename;
            name = null;
            opts = {};
        } else if (typeof options === 'function') {
            done = options;
            opts = {};
        }

        // support optional filename, where options may be in it's place
        if (typeof filename === 'object' &&
            (typeof options === 'function' || options === undefined)) {
            name = null;
            opts = filename;
        }
        if(!name) {
            name = Path.basename(path);
        }
        if(!opts.root) {
            opts.root = process.cwd();
        }

        this.attachment(name);
        this.sendFile(path, opts, done);
    }
    set(field, value) {
        if(this.headersSent) {
            throw new Error('Can\'t write headers: Response was already sent');
        }
        if(typeof field === 'object') {
            for(const header in field) {
                this.set(header, field[header]);
            }
        } else {
            if(field === 'set-cookie' && Array.isArray(value)) {
                value = value.join('; ');
            }
            this.headers[field.toLowerCase()] = String(value);
        }
        return this;
    }
    header(field, value) {
        return this.set(field, value);
    }
    setHeader(field, value) {
        return this.set(field, value);
    }
    get(field) {
        return this.headers[field.toLowerCase()];
    }
    getHeader(field) {
        return this.get(field);
    }
    removeHeader(field) {
        delete this.headers[field.toLowerCase()];
        return this;
    }
    append(field, value) {
        field = field.toLowerCase();
        if(this.headers[field]) {
            if(typeof value === 'string' || typeof value === 'number') {
                this.headers[field] += ', ' + value;
            } else if(Array.isArray(value)) {
                this.headers[field] += ', ' + value.join(', ');
            }
        } else {
            if(typeof value === 'string' || typeof value === 'number') {
                this.headers[field] = value.toString();
            } else if(Array.isArray(value)) {
                this.headers[field] = value.join(', ');
            }
        }
        return this;
    }
    render(view, options, callback) {
        if(typeof options === 'function') {
            callback = options;
            options = {};
        }
        if(!options) {
            options = {};
        } else {
            options = Object.assign({}, options);
        }
        options._locals = this.locals;
        const done = callback || ((err, str) => {
            if(err) return this.req.next(err);
            this.send(str);
        });

        this.app.render(view, options, done);
    }
    cookie(name, value, options) {
        if(!options) {
            options = {};
        }
        // TODO: signed cookies
        let val = typeof value === 'object' ? "j:"+JSON.stringify(value) : String(value);
        if(options.maxAge != null) {
            const maxAge = options.maxAge - 0;
            if(!isNaN(maxAge)) {
                options.expires = new Date(Date.now() + maxAge);
                options.maxAge = Math.floor(maxAge / 1000);
            }
        }
        if(options.signed) {
            val = 's:' + sign(val, this.req.secret);
        }

        if(options.path == null) {
            options.path = '/';
        }

        this.append('Set-Cookie', cookie.serialize(name, val, options));
        return this;
    }
    clearCookie(name, options) {
        const opts = { path: '/', ...options, expires: new Date(1) };
        delete opts.maxAge;
        return this.cookie(name, '', opts);
    }
    attachment(filename) {
        this.set('Content-Disposition', `attachment; filename="${filename}"`);
        this.type(filename.split('.').pop());
        return this;
    }
    format(object) {
        const keys = Object.keys(object).filter(v => v !== 'default');
        const key = keys.length > 0 ? this.req.accepts(keys) : false;

        this.vary('Accept');

        if(key) {
            this.set('Content-Type', normalizeType(key).value);
            object[key](this.req, this, this.req.next);
        } else if(object.default) {
            object.default(this.req, this, this.req.next);
        } else {
            this.status(406).send(this.app._generateErrorPage('Not Acceptable'));
        }

        return this;
    }
    json(body) {
        if(!this.get('Content-Type')) {
            this.set('Content-Type', 'application/json');
        }
        const escape = this.app.get('json escape');
        const replacer = this.app.get('json replacer');
        const spaces = this.app.get('json spaces');
        this.send(stringify(body, replacer, spaces, escape));
    }
    jsonp(object) {
        let callback = this.req.query[this.app.get('jsonp callback name')];
        let body = stringify(object, this.app.get('json replacer'), this.app.get('json spaces'), this.app.get('json escape'));

        if(!this.get('Content-Type')) {
            this.set('Content-Type', 'application/javascript');
            this.set('X-Content-Type-Options', 'nosniff');
        }

        if(Array.isArray(callback)) {
            callback = callback[0];
        }

        if(typeof callback === 'string' && callback.length !== 0) {
            this.set('Content-Type', 'application/javascript');
            this.set('X-Content-Type-Options', 'nosniff');
            callback = callback.replace(/[^\[\]\w$.]/g, '');

            if(body === undefined) {
                body = '';
            } else if(typeof body === 'string') {
                // replace chars not allowed in JavaScript that are in JSON
                body = body
                    .replace(/\u2028/g, '\\u2028')
                    .replace(/\u2029/g, '\\u2029')
            }
            body = '/**/ typeof ' + callback + ' === \'function\' && ' + callback + '(' + body + ');';
        }

        return this.send(body);
    }
    links(links) {
        this.set('Link', Object.entries(links).map(([rel, url]) => `<${url}>; rel="${rel}"`).join(', '));
        return this;
    }
    location(path) {
        if(path === 'back') {
            path = this.req.get('Referrer');
            if(!path) path = this.req.get('Referer');
            if(!path) path = '/';
        }
        return this.set('Location', encodeURI(path));
    }
    redirect(status, url) {
        if(typeof status !== 'number' && !url) {
            url = status;
            status = 302;
        }
        this.location(url);
        this.status(status);
        this.set('Content-Type', 'text/plain');
        return this.send(`${statuses.message[status] ?? status}. Redirecting to ${url}`);
    }

    type(type) {
        const ct = type.indexOf('/') === -1
            ? (mime.contentType(type) || 'application/octet-stream')
            : type;
        return this.set('Content-Type', ct);
    }
    contentType(type) {
        return this.type(type);
    }

    vary(field) {
        vary(this, field);
        return this;
    }

    get finished() {
        return !this.socket.writable;
    }

    get writableFinished() {
        return !this.socket.writable;
    }
}

function pipeStreamOverResponse(res, readStream, totalSize, callback) {
    readStream.on('data', (chunk) => {
        if(res.aborted) {
            const err = new Error("Request aborted");
            err.code = "ECONNABORTED";
            return readStream.destroy(err);
        }
        res._res.cork(() => {
            if(!res.headersSent) {
                res.writeHead(res.statusCode);
                res._res.writeStatus(res.statusCode.toString());
                for(const header in res.headers) {
                    if(header === 'content-length') {
                        continue;
                    }
                    res._res.writeHeader(header, res.headers[header]);
                }
                if(!this.headers['content-type']) {
                    this._res.writeHeader('content-type', 'text/html');
                }
                res.headersSent = true;
            }
            const ab = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
        
            const lastOffset = res._res.getWriteOffset();
            const [ok, done] = res._res.tryEnd(ab, totalSize);
      
            if (done) {
                readStream.destroy();
                res.socket.emit('close');
                if(callback) callback();
            } else if (!ok) {
                readStream.pause();
        
                res._res.ab = ab;
                res._res.abOffset = lastOffset;
        
                res._res.onWritable((offset) => {  
                    const [ok, done] = res._res.tryEnd(res._res.ab.slice(offset - res._res.abOffset), totalSize);
                    if (done) {
                        readStream.destroy();
                        res.socket.emit('close');
                        if(callback) callback();
                    } else if (ok) {
                        readStream.resume();
                    }
            
                    return ok;
                });
            }
        });
    }).on('error', e => {
        if(callback) callback(e);
        if(!res.finished) {
            res._res.close();
            res.socket.emit('error', e);
        }
    });
  }
  