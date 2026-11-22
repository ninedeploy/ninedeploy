<?php

use Illuminate\Support\Facades\Route;

Route::get('/', static fn () => ['starter' => 'NineDeploy Laravel starter']);
Route::get('/healthz', static fn () => ['status' => 'ok']);
