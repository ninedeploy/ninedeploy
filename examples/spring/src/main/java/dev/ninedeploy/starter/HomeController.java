package dev.ninedeploy.starter;

import java.util.Map;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class HomeController {

    @GetMapping("/")
    public Map<String, String> index() {
        return Map.of("starter", "NineDeploy Spring starter");
    }

    // The health check the deployment waits for (.ninedeploy: run.healthcheck).
    @GetMapping("/healthz")
    public Map<String, String> health() {
        return Map.of("status", "ok");
    }
}
