'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(cors());
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false }));

// Serve static web assets
app.use(express.static(path.join(__dirname, 'public')));

// In-memory storage of readings
let previousReading = null;
let latestReading = null;

function toRadians(deg) {
	return (deg * Math.PI) / 180;
}

function toDegrees(rad) {
	return (rad * 180) / Math.PI;
}

// Haversine distance in meters
function haversineDistanceMeters(lat1, lon1, lat2, lon2) {
	const R = 6371000;
	const dLat = toRadians(lat2 - lat1);
	const dLon = toRadians(lon2 - lon1);
	const a =
		Math.sin(dLat / 2) * Math.sin(dLat / 2) +
		Math.cos(toRadians(lat1)) *
			Math.cos(toRadians(lat2)) *
			Math.sin(dLon / 2) *
			Math.sin(dLon / 2);
	const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
	return R * c;
}

// POST endpoint for ESP8266
app.post('/api/readings', (req, res) => {
	try {
		const body = req.body || {};
		const now = Date.now();

		const reading = {
			temperature: typeof body.temperature === 'number' ? body.temperature : null,
			humidity: typeof body.humidity === 'number' ? body.humidity : null,
			accel: body.accel || null,
			gyro: body.gyro || null,
			lat: typeof body.lat === 'number' ? body.lat : null,
			lon: typeof body.lon === 'number' ? body.lon : null,
			timestamp: now
		};

		let intensity = null;
		let intensityUnit = null;
		let pitch = null;
		let roll = null;
		let gX = null;
		let gY = null;
		let gZ = null;

		if (
			reading.lat !== null &&
			reading.lon !== null &&
			previousReading &&
			previousReading.lat !== null &&
			previousReading.lon !== null
		) {
			const dtMs = Math.max(1, reading.timestamp - previousReading.timestamp);
			const dMeters = haversineDistanceMeters(
				previousReading.lat,
				previousReading.lon,
				reading.lat,
				reading.lon
			);
			intensity = dMeters / (dtMs / 1000);
			intensityUnit = 'm_s';
		}

		if (reading.accel && typeof reading.accel.x === 'number') {
			const ax = Number(reading.accel.x);
			const ay = Number(reading.accel.y);
			const az = Number(reading.accel.z);
			const scale = 16384; // LSB per g at ±2g
			gX = ax / scale;
			gY = ay / scale;
			gZ = az / scale;

			if (intensity === null) {
				const magG = Math.sqrt(gX * gX + gY * gY + gZ * gZ);
				const linG = Math.max(0, magG - 1);
				const MS2_PER_G = 9.80665;
				intensity = linG * MS2_PER_G;
				intensityUnit = 'm_s2';
			}

			const denomPitch = Math.sqrt(gY * gY + gZ * gZ);
			const pitchRad = Math.atan2(gX, denomPitch || 1e-9);
			const rollRad = Math.atan2(-gY, gZ || 1e-9);
			pitch = Number.isFinite(pitchRad) ? toDegrees(pitchRad) : null;
			roll = Number.isFinite(rollRad) ? toDegrees(rollRad) : null;
		}

		// Collect alerts
		const alerts = [];

		if (reading.temperature !== null) {
			if (reading.temperature > 50) {
				alerts.push('🔥 DANGEROUS: Temperature extremely high');
			} else if (reading.temperature > 40) {
				alerts.push('⚠️ High temperature detected');
			} else if (reading.temperature < 0) {
				alerts.push('❄️ Temperature below freezing');
			}
		}

		if (reading.humidity !== null) {
			if (reading.humidity > 90) {
				alerts.push('💧 Humidity critically high');
			} else if (reading.humidity < 20) {
				alerts.push('🌵 Humidity very low');
			}
		}

		if (intensityUnit === 'm_s' && typeof intensity === 'number' && intensity > 20) {
			alerts.push('🚗 Sudden high movement speed detected');
		}

		if (reading.accel) {
			const axAbs = Math.abs(Number(reading.accel.x || 0));
			const ayAbs = Math.abs(Number(reading.accel.y || 0));
			const azAbs = Math.abs(Number(reading.accel.z || 0));

			// More sensitive: trigger if Z is less than ~0.7g (was 0.5g)
			if (azAbs < 12000) {
				alerts.push('📦 Device might be tilted or falling');
			}

			const total = Math.sqrt(axAbs * axAbs + ayAbs * ayAbs + azAbs * azAbs);
			// More sensitive: trigger at lower impact threshold (was 25000)
			if (total > 15000) {
				alerts.push('💥 Sudden impact/shock detected!');
			}
		}

		latestReading = { ...reading, intensity, intensityUnit, pitch, roll, alerts };
		previousReading = reading;

		res.status(200).json({ ok: true });
	} catch (err) {
		console.error('Error handling /api/readings:', err);
		res.status(400).json({ ok: false, error: 'Invalid payload' });
	}
});



app.get('/api/latest', (_req, res) => {
	if (!latestReading) {
		return res.status(200).json({ ok: true, data: null });
	}
	res.status(200).json({ ok: true, data: latestReading });
});



// Health
app.get('/health', (_req, res) => res.status(200).send('OK'));

app.listen(PORT, '10.139.30.53', () => {
	console.log(`Server listening on http://10.139.30.53:${PORT}`);
});
