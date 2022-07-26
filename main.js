const DEBUG = true;

const { Client } = require('tplink-smarthome-api');
const { Server } = require('socket.io');
const fs = require('fs');
const http = require('http');
const static = require('node-static');
const Router = require('node-router');
const noble = require('@abandonware/noble');

const config = JSON.parse(fs.readFileSync("config.json"));

const DEFAULT_THRESHOLDS = {
    'HR_TRIGGER'    : 170,
    'HR_MAX'        : 220
};

const SERVICE_UUIDS = {
    '180d'  : 'HEART_RATE',
    '1816'  : 'SPEED_CADENCE',
    '1818'  : 'POWER'
};

const CHARACTERISTIC_UUIDS = {
    '2a37'  : 'HEART_RATE_MEASUREMENT',
    '2a19'  : 'BATTERY_LEVEL',
    '2a38'  : 'BODY_SENSOR_LOCATION',
    '2a63'  : 'CYCLING_POWER_MEASUREMENT'
};

const SERVICE_DESCRIPTIONS = {
    'HEART_RATE'    : 'Heart Rate Monitor',
    'SPEED_CADENCE' : 'Speed/Cadence Sensor',
    'POWER'         : 'Power Meter'
};

const LISTEN_PORT = 3000;

var plug = null;

var sock = null;

var initDev = 0;

var init = false;
var isOn = false;

const client = new Client();

const wsChannels = [ 'device', 'fan', 'hrm' ];

var discoveredIoTDevices = {};
var discoveredBLEDevices = {};

var selectedActuator = null;
var selectedSensor = null;

function wsNotify(channel, data) {
    if(sock == null) return;
    if(wsChannels.includes(channel)) {
        sock.emit(channel, data);
    }
}

function sendIoTDeviceList() {
    for(var i in discoveredIoTDevices) {
        var info = discoveredIoTDevices[i]['info'];
        if(info == null) continue;
        wsNotify('device', {
            'type'  : 'actuator',
            'id'    : info.deviceId,
            'name'  : info.alias
        });
    }
}

function sendBLEDeviceList() {
    for(uuid in discoveredBLEDevices) {
        var peripheral = discoveredBLEDevices[uuid]['peripheral'];
        wsNotify('device', {
            'type'  : 'sensor',
            'id'    : peripheral.uuid,
            'name'  : peripheral.advertisement.localName
        });
    }
}

function switchOnFan() {
    if(plug != null && !isOn) {
        plug.setPowerState(true);
    }
}

function switchOffFan() {
    if(plug != null && isOn) {
        plug.setPowerState(false);
    }
}

function getIoTDeviceState(deviceId) {
    if(deviceId in discoveredIoTDevices) {
        discoveredIoTDevices[deviceId]['device'].getSysInfo().then(function(info) {
            discoveredIoTDevices[deviceId]['info'] = info;
            if(info.relay_state !== undefined) {}
        });
    }
}

function enumerateDevices() {
    console.log('Following devices were discovered:');
    for(var i in discoveredIoTDevices) {
        var info = discoveredIoTDevices[i]['info'];
        var devType = (info.mic_type == undefined) ? info.type : info.mic_type;
        console.log(devType + '\t: ' + info.model + ' (' + info.alias + ')');
    }
    sendIoTDeviceList();
}

setTimeout(enumerateDevices, 3000);
client.startDiscovery().on('device-new', (device) => {
    discoveredIoTDevices[device.deviceId] = {
        'device'    : device,
        'info'      : null
    };
    getIoTDeviceState(device.deviceId);
});

noble.on('scanStart', function() {
    console.log('Scanning for devices...');
});

function monitor() {}

function processHRData(data) {
    var buflen = data.length;
    var hrate = (buflen == 2) ? data.readInt16BE() : (data.readInt32BE() & 0x00FF0000) >> 16;
    if(DEBUG) console.log(`Heart Rate ${hrate} BPM`);
    wsNotify('hrm', {
        'hr'    : hrate
    });
}

var characteristicDataCallbacks = {
    '2a37'  : processHRData
};

function isBLEPeripheralConnected(peripheral) {
    var isConnected = (peripheral.state === 'connected');
    if(peripheral.uuid in discoveredBLEDevices) discoveredBLEDevices[peripheral.uuid]['isConnected'] = isConnected;
    return isConnected;
}

function subscribeBLECharacteristic(characteristic) {
    if(characteristic.uuid in characteristicDataCallbacks) {
        characteristic.on('data', characteristicDataCallbacks[characteristic.uuid]);
        characteristic.subscribe(function(err) {
            if(err != null) console.log(err);
            else {
                console.log(`Subscribed to ${SERVICE_UUIDS[characteristic._serviceUuid]} characteristic ${CHARACTERISTIC_UUIDS[characteristic.uuid]}`);
            }
        });
    }
}

function connectBLEPeripheral(peripheral) {
    peripheral.connect(function(err) {
        if(err != null) console.log(err);
        else {
            peripheral.discoverAllServicesAndCharacteristics(function(error, services, characteristics) {
                if(error != null) console.log(error);
                else {
                    for(var i in characteristics) {
                        if(characteristics[i].uuid in CHARACTERISTIC_UUIDS) {
                            discoveredBLEDevices[peripheral.uuid]['characteristics'][characteristics[i].uuid] = characteristics[i];
                            console.log(`[${peripheral.advertisement.localName}] characteristic ${CHARACTERISTIC_UUIDS[characteristics[i].uuid]}`);
                            subscribeBLECharacteristic(characteristics[i]);
                        }
                    }
                }
            });
            isBLEPeripheralConnected(peripheral);
        }
    });
}

noble.on('discover', function(peripheral) {
    if(peripheral.uuid in discoveredBLEDevices) return;
    if(!peripheral.connectable) return;
    for(var i in peripheral.advertisement.serviceUuids) {
        var uuid = peripheral.advertisement.serviceUuids[i];
        if(uuid in SERVICE_UUIDS) {
            console.log(`Discovered ${SERVICE_DESCRIPTIONS[SERVICE_UUIDS[uuid]]} ${peripheral.advertisement.localName}`)
            discoveredBLEDevices[peripheral.uuid] = {
                'peripheral'        : peripheral,
                'characteristics'   : {},
                'isConnected'       : false
            };
            wsNotify('device', {
                'type'  : 'sensor',
                'id'    : peripheral.uuid,
                'name'  : peripheral.advertisement.localName
            });
        }
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
    console.log('Connected to web interface.');
    sendIoTDeviceList();
    sendBLEDeviceList();
    sock.on('monitor', function(data) {
        selectedSensor = data.sensor;
        selectedActuator = data.actuator;
        if(selectedSensor in discoveredBLEDevices) {
            var peripheral = discoveredBLEDevices[selectedSensor]['peripheral'];
            connectBLEPeripheral(peripheral);
        }
    });
});

server.listen(LISTEN_PORT, function() {
    console.log('Listening on *:', LISTEN_PORT);
});
