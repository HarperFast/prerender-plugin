import mqtt from 'mqtt';
import { settings } from '../settings.js';

export const connectMqtt = async () => {
	const { mqttOrigin, workerId, user, pass } = settings.harper;
	return mqtt.connectAsync(mqttOrigin, {
		clean: true,
		clientId: workerId,
		username: user,
		password: pass,
		wsOptions: {
			protocol: 'mqtt',
		},
	});
};
