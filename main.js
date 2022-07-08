const { Client } = require('tplink-smarthome-api');
const { Server } = require('socket.io');
const fs = require('fs');
const http = require('http');
const static = require('node-static');
const Router = require('node-router');
const noble = require('noble-winrt');

const config = JSON.parse(fs.readFileSync("config.json"));

const FAN_PLUG_DEVID = config['plug-devid'];

const HRM_DUAL_UUID = config['hrm-uuid'];
const HRM_DUAL_MAC = config['hrm-mac'];
const HR_THRESH_LOW = config['hr-thres-low'];
const HR_THRESH_HIGH = config['hr-thres-high'];

const SERVICE_UUID_HRM = "180d";
const CHARACTERISTIC_UUID_HRM = "2a37";
const HR_MAX = 220;
const DEVMASK_PLUG = 1;
const DEVMASK_HRM = 2;

const LISTEN_PORT = 3000;

var hrm = null;
var plug = null;

var sock = null;

var initDev = 0;

var init = false;
var currHR = null;
var isOn = false;

const client = new Client();

function switchOnFan() {
    if(plug != null && !isOn) {
        plug.setPowerState(true);
        if(sock != null) sock.emit('fan', { 'err' : null, 'data' : 'on' });
    }
}

function switchOffFan() {
    if(plug != null && isOn) {
        plug.setPowerState(false);
        if(sock != null) sock.emit('fan', { 'err' : null, 'data' : 'off' });
    }
}

function checkInit(devMask) {
    initDev |= devMask;
    init = (initDev == 3);
    if(init) console.log('Devices initialized.');
}

client.startDiscovery().on('device-new', (device) => {
    if(device.deviceId === FAN_PLUG_DEVID) {
        console.log('Fan smart plug found!');
        checkInit(DEVMASK_PLUG);
        plug = device;
        if(plug._sysInfo.relay_state == 1) isOn = true;
    }
    device.getSysInfo().then(function(data) {
        devInfoFile = 'devices/' + device.deviceId + '.json';
        fs.writeFileSync(devInfoFile, JSON.stringify(data, null, 4));
    });
});

console.log('Discovery started.');

noble.on('scanStart', function() {
    console.log('Scanning for devices...');
});

noble.on('discover', function(peripheral) {
    if(peripheral.uuid === HRM_DUAL_UUID) {
        console.log('Discovered HRM peripheral.');
        checkInit(DEVMASK_HRM);
        hrm = peripheral;
        noble.stopScanning();
        hrm.connect(function(err) {
            if(err != null) console.log(err);
            hrm.discoverAllServicesAndCharacteristics(function(error, services, characteristics) {
                for(var i in characteristics) {
                    var c = characteristics[i];
                    var suuid = c._serviceUuid.split('-')[0];
                    var cuuid = c.uuid.split('-')[0];
                    var properties = c.properties;
                    if(suuid.indexOf(SERVICE_UUID_HRM) >= 0 && cuuid.indexOf(CHARACTERISTIC_UUID_HRM) >= 0 && properties.includes('notify')) {
                        console.log('subscribing to hrm characteristic.');
                        c.on('data', function(data) {
                            if(!init) {
                                return;
                            }
                            var buflen = data.length;
                            var hrate = (buflen == 2) ? data.readInt16BE() : (data.readInt32BE() & 0x00FF0000) >> 16;
                            if(sock != null) {
                                sock.emit('hr', { 'err' : null, 'data' : hrate });
                                sock.emit('fan', { 'err' : null, 'data' : (isOn ? 'on' : 'off') });
                            }
                            if(hrate != currHR && hrate < HR_MAX && hrate > 0) {
                                currHR = hrate;
                                if(hrate > HR_THRESH_HIGH) {
                                    console.log('Heart rate increased to workout zone:', hrate);
                                    switchOnFan();
                                } else if(hrate < HR_THRESH_LOW) {
                                    console.log('Heart rate dropped to recovery zone:', hrate);
                                    switchOffFan();
                                }
                            }
                        });
                        c.subscribe(function(err) {
                            if(err != null) console.log(err);
                        });
                    }
                }
            });
        });
    }
});

noble.startScanning();

const localfs = new(static.Server)('static');
const router = Router();
const route = router.push;

route('/on', function(req, res, next) {
    if(plug._sysInfo.relay_state == 0) {
        switchOnFan();
        res.send(JSON.stringify({
            'success'   : true,
            'err'       : null
        }));
    } else {
        res.send(JSON.stringify({
            'success'   : false,
            'err'       : 'already running'
        }));
    }
});

route('/off', function(req, res, next) {
    if(plug._sysInfo.relay_state == 1) {
        switchOffFan();
        res.send(JSON.stringify({
            'success'   : true,
            'err'       : null
        }));
    } else {
        res.send(JSON.stringify({
            'success'   : false,
            'err'       : 'already stopped'
        }));
    }
});

route(function(req, res, next) {
    localfs.serve(req, res);
});

route(function(err, req, res, next) {
    res.send(JSON.stringify(err));
});

const server = http.createServer(router);
const io = new Server(server);

io.on('connection', function(socket) {
    sock = socket;
    sock.emit('fan', { 'err' : null, 'data' : (isOn ? 'on' : 'off') });
    console.log('Connected to web interface.');
});

server.listen(LISTEN_PORT, function() {
    console.log('Listening on *:', LISTEN_PORT);
});