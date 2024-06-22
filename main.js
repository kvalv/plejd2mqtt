const api = require('./api');
const mqtt = require('./mqtt');
const PlejdBluetoothService = require('./ble.bluez');
const SceneManager = require('./scene.manager');

const version = "0.4.7";

async function main() {
  console.log('starting Plejd add-on v. ' + version);

  // const rawData = fs.readFileSync('/data/plejd.json');
  // const config = JSON.parse(rawData);

  const config = {
    site: process.env.PLEJD_SITE || "Default Site",
    username: process.env.PLEJD_USERNAME || "",
    password: process.env.PLEJD_PASSWORD || "",
    mqttBroker: process.env.MQTT_BROKER || "mqtt://localhost",
    mqttUsername: process.env.MQTT_USERNAME || "",
    mqttPassword: process.env.MQTT_PASSWORD || "",
    includeRoomsAsLights: process.env.PLEJD_INCLUDE_ROOMS_AS_LIGHTS || false,
    connectionTimeout: process.env.BLUETOOTH_TIMEOUT || 2,
    writeQueueWaitTime: process.env.BLUETOOTH_WAIT || 400,
  }

  if (!config.connectionTimeout) {
    config.connectionTimeout = 2;
  }

  const plejdApi = new api.PlejdApi(config.site, config.username, config.password);
  const mqttClient = new mqtt.MqttClient(config.mqttBroker, config.mqttUsername, config.mqttPassword);

  ['SIGINT', 'SIGHUP', 'SIGTERM'].forEach(signal => {
    process.on(signal, () => {
      console.log(`Received ${signal}. Cleaning up.`);
      mqttClient.disconnect(() => process.exit(0));
    });
  });

  await plejdApi.login();
  const site = await plejdApi.getSites();
  const cryptoKey = await plejdApi.getSite(site.site.siteId);

  // parse all devices from the API
  const devices = plejdApi.getDevices();

  mqttClient.on('connected', () => {
    console.log('plejd-mqtt: connected to mqtt.');
    mqttClient.discover(devices);
  });

  mqttClient.init();

  // init the BLE interface
  const sceneManager = new SceneManager(plejdApi.site, devices);
  const bt = new PlejdBluetoothService(cryptoKey, devices, sceneManager, config.connectionTimeout, config.writeQueueWaitTime, true);
  bt.on('connectFailed', () => {
    console.log('plejd-ble: were unable to connect, will retry connection in 10 seconds.');
    setTimeout(() => {
      bt.init();
    }, 10000);
  });

  bt.init();

  bt.on('authenticated', () => {
    console.log('plejd: connected via bluetooth.');
  });

  // subscribe to changes from Plejd
  bt.on('stateChanged', (deviceId, command) => {
    console.log("bt -- stateChanged", deviceId, command);
    mqttClient.publish("z/home/lights/sofa", JSON.stringify(command));
  });

  bt.on('sceneTriggered', (deviceId, scene) => {
    mqttClient.sceneTriggered(scene);
  });

  // subscribe to changes from HA
  mqttClient.on('stateChanged', (device, command) => {
    const deviceId = device.id;

    if (device.typeName === 'Scene') {
      // we're triggering a scene, lets do that and jump out.
      // since scenes aren't "real" devices.
      bt.triggerScene(device.id);
      return;
    }

    let state = 'OFF';
    let commandObj = {};

    if (typeof command === 'string') {
      // switch command
      state = command;
      commandObj = {
        state: state
      };

      // since the switch doesn't get any updates on whether it's on or not,
      // we fake this by directly send the updateState back to HA in order for
      // it to change state.
      mqttClient.updateState(deviceId, {
        state: state === 'ON' ? 1 : 0
      });
    } else {
      state = command.state;
      commandObj = command;
    }

    if (state === 'ON') {
      bt.turnOn(deviceId, commandObj);
    } else {
      bt.turnOff(deviceId, commandObj);
    }
  });
}

main();
