const express = require('express');

function configureMiddleware(app) {
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
}

module.exports = configureMiddleware;
