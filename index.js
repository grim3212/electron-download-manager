'use strict';
const path = require('path');
const electron = require('electron');
const { BrowserWindow, net } = electron;

const app = electron.app;
let downloadFolder = app.getPath("downloads");
let lastWindowCreated;

let queue = [];

function _registerListener(win, opts = {}, cb = () => {}) {

    lastWindowCreated = win;
	downloadFolder = opts.downloadFolder || downloadFolder;

    const listener = (e, item, webContents) => {

        let queueItem = _popQueueItem(item.getFilename());
		
		if (queueItem) {

			const filePath = queueItem.path ? path.join(queueItem.path, item.getFilename()) : path.join(downloadFolder, item.getFilename());

			const totalBytes = item.getTotalBytes();

			item.setSavePath(filePath);

			// Resuming an interupted download
			if (item.getState() === 'interrupted') {
				item.resume();
			}

			item.on('updated', () => {
				const progress = item.getReceivedBytes() * 100 / totalBytes;

				if (typeof queueItem.onProgress === 'function') {
					queueItem.onProgress(progress, item);
				}
			});

			item.on('done', (e, state) => {

				let finishedDownloadCallback = queueItem.callback || function() {};

				if (!win.isDestroyed()) {
					win.setProgressBar(-1);
				}

				if (state === 'interrupted') {
					const message = `The download of ${item.getFilename()} was interrupted`;

					finishedDownloadCallback(new Error(message), { 
						path: item.getSavePath(),
						url: item.getURL(),
						mimeType: item.getMimeType(),
						filename: item.getFilename(),
						size: item.getTotalBytes(),
						state: item.getState(),
						lastModified: item.getLastModifiedTime()
					});

				} else if (state === 'completed') {
					if (process.platform === 'darwin') {
						app.dock.downloadFinished(filePath);
					}
					// TODO: remove this listener, and/or the listener that attach this listener to newly created windows
					// if (opts.unregisterWhenDone) {
					//     webContents.session.removeListener('will-download', listener);
					// }

					finishedDownloadCallback(null, { 
						path: item.getSavePath(),
						url: item.getURL(),
						mimeType: item.getMimeType(),
						filename: item.getFilename(),
						size: item.getTotalBytes(),
						state: item.getState(),
						lastModified: item.getLastModifiedTime()
					});
				}
			});
		}
    };

    win.webContents.session.on('will-download', listener);
}

var register = (opts = {}) => {
    app.on('browser-window-created', (e, win) => {
        _registerListener(win, opts);
    });
};

var fs = require('fs');

var download = (options, callback) => {
    let win = BrowserWindow.getFocusedWindow() || lastWindowCreated;
    options = Object.assign({}, {
        path: ""
    }, options);
	
	const request = net.request({url: options.url, redirect: 'manual'});
	
	var url = '';
	
	request.on("redirect", function(status, method, redirectUrl, headers) {
		request.followRedirect();
		
		url = redirectUrl;
	});

    request.on("response", function(response) {
        request.abort();
		
		const filename = decodeURIComponent(path.basename(url));

        queue.push({
            url: url,
			filename: filename,
            path: options.path.toString(),
            callback: callback,
            onProgress: options.onProgress
        });

        const filePath = options.path.toString() ? path.join(options.path.toString(), filename) : path.join(downloadFolder, filename);

        if (fs.existsSync(filePath)) {
            const stats = fs.statSync(filePath);

            const fileOffset = stats.size;

            const serverFileSize = parseInt(response.headers["content-length"]);

            console.log(filename + ' exists, verifying file size: (' + fileOffset + ' / ' + serverFileSize + " downloaded)");

            // Check if size on disk is lower than server
            if (fileOffset < serverFileSize) {
                console.log('File needs re-downloaded as it was not completed');

                options = {
                    path: filePath,
                    urlChain: [url],
                    offset: parseInt(fileOffset),
                    length: serverFileSize,
                    lastModified: response.headers["last-modified"]
                };

                win.webContents.session.createInterruptedDownload(options);
            } else {
                console.log(filename + ' verified, no download needed');

                let finishedDownloadCallback = callback || function() {};

                finishedDownloadCallback(null, { 
					path: filePath,
					url: url,
					mimeType: response.headers["content-type"],
					filename: filename,
					size: fileOffset,
					state: 'completed',
					lastModified: response.headers["last-modified"]
				});
            }

        } else {
            console.log(filename + ' does not exist, try and download it now');
			
			//Don't try to download if the status code isn't OK
			if(response.statusCode == 404 || response.statusCode == 410){
				let finishedDownloadCallback = callback || function() {};

                finishedDownloadCallback(new Error('download for ' + url + ' was not found. [StatusCode] = ' + response.statusCode), { 
					path: filePath,
					url: url,
					mimeType: response.headers["content-type"],
					filename: filename,
					size: 0,
					state: 'not-available'
				});
			}else{
				if(response.statusCode != 200){
					console.log('download exists but ' + url + ' returned a status code of ' + response.statusCode);
				}
			
				win.webContents.downloadURL(options.url);
			}
        }
    });

	//End the request
	request.end();
}

var bulkDownload = (options, callback) => {

	//You can declare a path that they will go into by default or 
	//the downloads array may contain a path

    options = Object.assign({}, {
        downloads: [],
        path: ""
    }, options);

    let urlsCount = options.downloads.length;
    let finished = [];
    let errors = [];

    options.downloads.forEach((dl) => {
        download({
            url: dl.url,
            path: dl.path ? dl.path : options.path,
			onProgress: dl.onProgress
        }, function(error, item) {
		
            if (error) {
                errors.push(item);
            } else {
                finished.push(item);
            }
			
			//Call an optional callback for each dl item
			let finishedDownloadCallback = dl.callback || function() {};
			
			finishedDownloadCallback(error, item);

            let errorsCount = errors.length;
            let finishedCount = finished.length;

            if ((finishedCount + errorsCount) == urlsCount) {
                if (errorsCount > 0) {
                    callback(new Error(errorsCount + " downloads failed"), finished, errors);
                } else {
                    callback(null, finished, []);
                }
            }
        })
    });
}

var _popQueueItem = (filename) => {
    let queueItem = queue.find(item => item.filename === filename);
    queue.splice(queue.indexOf(queueItem), 1);
    return queueItem;
}

module.exports = {
    register,
    download,
    bulkDownload
}