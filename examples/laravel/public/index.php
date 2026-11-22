<?php

use Illuminate\Http\Request;

require dirname(__DIR__).'/vendor/autoload.php';

(require dirname(__DIR__).'/bootstrap/app.php')->handleRequest(Request::capture());
