require('dotenv').config();
const validateEnv = require('./utils/validateEnv');
const logger = require('./utils/logger');

validateEnv();

const app = require('./app');

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => logger.info(`Server running on port ${PORT}`, { port: PORT }));
